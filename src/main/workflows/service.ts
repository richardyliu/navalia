/**
 * Workflow catalog: Runtime-observed (skill files + behavior_patterns playbooks) merged with
 * the Lens Store (edited / imported). A stored id always wins over the live observed copy.
 */
import { tr } from '../../shared/i18n'
import { workflowFromPatternSkill, type PatternSkill } from './parse'
import { readRuntimeSkills } from './runtime'
import { parseExtraction, type ExtractSaveAs } from './extract'
import type { ExtractSaveResult, ImportReport, WorkflowCatalog, WorkflowDetail } from './api'
import { WorkflowIdSchema, type ExtractionMeta, type Workflow, type WorkflowEdit } from './schema'
import { WorkflowError, contentHash, createWorkflowStore } from './store'

export interface WorkflowServiceDeps {
  storeRoot: string
  runtimeRoot: () => string
  /** Runtime MCP call; optional (the Broker reader does not call MCP). */
  ossTool?: (name: string, args: Record<string, unknown>) => Promise<string>
  now?: () => Date
}

function evidenceKey(w: Workflow): string {
  return w.evidence
    .map((e) => e.ref)
    .sort()
    .join('\n')
}

function sameObserved(a: Workflow, b: Workflow): boolean {
  return contentHash(a) === contentHash(b) && evidenceKey(a) === evidenceKey(b)
}

/** Imported / shared content (or an edit of it): it must never stand in for an observed id. */
export function isForeignWorkflow(w: Workflow): boolean {
  const k = w.provenance.kind === 'user_edited' ? w.provenance.original_kind : w.provenance.kind
  // S2-07: an external-agent extraction is not Runtime observation either, whatever label the user chose.
  return k === 'imported' || k === 'shared' || !!w.provenance.extraction
}

export function parsePatternSkills(text: string): PatternSkill[] {
  const json = JSON.parse(text) as { skills?: unknown }
  if (!json || !Array.isArray(json.skills)) return []
  return json.skills.filter(
    (s): s is PatternSkill => !!s && typeof s === 'object' && typeof (s as PatternSkill).path === 'string' && typeof (s as PatternSkill).playbook === 'string'
  )
}

export function createWorkflowService(deps: WorkflowServiceDeps) {
  const store = createWorkflowStore(deps.storeRoot, deps.now)

  function observedSync(): { list: Workflow[]; status: string } {
    const r = readRuntimeSkills(deps.runtimeRoot())
    return { list: r.workflows, status: r.status }
  }

  async function observedWithPatterns(): Promise<{ list: Workflow[]; files: string; patterns: string }> {
    const files = observedSync()
    const list = [...files.list]
    let patterns = 'skipped'
    if (deps.ossTool) {
      try {
        const skills = parsePatternSkills(await deps.ossTool('behavior_patterns', {}))
        for (const s of skills) {
          const w = workflowFromPatternSkill(s)
          if (!list.some((x) => x.id === w.id)) list.push(w)
        }
        patterns = 'ok'
      } catch (error) {
        patterns = error instanceof Error ? error.message : String(error)
      }
    }
    return { list, files: files.status, patterns }
  }

  /** True when a stored foreign copy collides with a live observed id (legacy imports, review #2). */
  function shadowed(stored: Workflow | null, observedList: Workflow[]): boolean {
    return !!stored && isForeignWorkflow(stored) && observedList.some((o) => o.id === stored.id)
  }

  function merge(observed: Workflow[]): Workflow[] {
    // A stored id wins over the observed copy, except a stored imported/shared copy: that never
    // shadows what the Runtime observed (security review #2). Such legacy rows are hidden.
    const stored = store.listLatest().filter((w) => !shadowed(w, observed))
    const ids = new Set(stored.map((w) => w.id))
    return [...stored, ...observed.filter((w) => !ids.has(w.id))].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || a.id.localeCompare(b.id))
  }

  function detailFrom(id: string, observedList: Workflow[]): WorkflowDetail | null {
    if (!WorkflowIdSchema.safeParse(id).success) return null
    const observed = observedList.find((w) => w.id === id) ?? null
    const stored = store.versions(id)
    const versions = shadowed(stored.length ? stored[stored.length - 1] : null, observedList) ? [] : stored
    const current = versions.length ? versions[versions.length - 1] : observed
    if (!current) return null
    const firstObserved = versions.find((v) => v.provenance.kind === 'observed') ?? null
    return {
      workflow: current,
      versions: versions.map((v) => ({ version: v.version, provenance: v.provenance.kind, updated_at: v.updated_at })),
      observed,
      runtimeChanged: !!(firstObserved && observed && !sameObserved(firstObserved, observed))
    }
  }

  return {
    store,
    /** Full catalog for the Playbook page (also asks Runtime behavior_patterns). */
    async catalog(): Promise<WorkflowCatalog> {
      const o = await observedWithPatterns()
      const workflows = merge(o.list)
      return { workflows, sources: { runtimeFiles: o.files, behaviorPatterns: o.patterns, store: store.listLatest().length } }
    },
    /** Catalog from files only (Runtime skill files + Lens Store). Used by the Broker. */
    catalogSync(): Workflow[] {
      return merge(observedSync().list)
    },
    async get(id: string): Promise<WorkflowDetail | null> {
      return detailFrom(id, (await observedWithPatterns()).list)
    },
    getSync(id: string): WorkflowDetail | null {
      return detailFrom(id, observedSync().list)
    },
    async save(id: string, baseVersion: number, edit: WorkflowEdit) {
      const latest = store.latest(id)
      const live = (await observedWithPatterns()).list
      if (shadowed(latest, live)) throw new WorkflowError('conflict', tr(
          `Navalia Store has an imported ${id} (an older import with the same id as an observed Workflow). It was ignored for safety, so this observed version can't be edited for now`,
          `Navalia Store 里有一份导入的 ${id}（旧版本导入，与观察到的 Workflow 同 id），为安全起见已忽略；暂时不能编辑这个观察版本`
        ))
      const observed = latest ? null : (live.find((w) => w.id === id) ?? null)
      return store.saveEdit(id, baseVersion, edit, observed)
    },
    async exportJson(ids: string[]): Promise<{ json: string; count: number }> {
      const all = (await observedWithPatterns()).list
      const list = ids.map((id) => {
        const d = detailFrom(id, all)
        if (!d) throw new Error(`workflow not found: ${id}`)
        return d.workflow
      })
      return { json: store.exportJson(list), count: list.length }
    },
    /**
     * S2-07: validate JSON pasted back from an external agent and store it under a fresh `ext-*` id.
     * No LLM, no network: Lens only validates (X7). Invalid JSON → WorkflowError('invalid') with
     * the Chinese, path-qualified messages from `parseExtraction`.
     */
    async saveExtracted(text: string, as: ExtractSaveAs, agent: string): Promise<ExtractSaveResult> {
      const parsed = parseExtraction(text)
      if (!parsed.ok) throw new WorkflowError('invalid', parsed.errors.join('\n'))
      const item = store.saveExtracted(parsed.draft, { as, agent }, (await observedWithPatterns()).list)
      return { item, form: parsed.form }
    },
    /** S1-FULL C15: save a reviewed cloud draft (dedupe against stored + live observed). */
    async saveCloudExtracted(edit: WorkflowEdit, meta: ExtractionMeta, evidenceNote: string) {
      return store.saveCloudExtracted(edit, meta, evidenceNote, (await observedWithPatterns()).list)
    },
    async importJson(text: string, fileName: string): Promise<ImportReport> {
      const parsed = store.parseImport(text)
      return store.importWorkflows(parsed, fileName, (await observedWithPatterns()).list)
    }
  }
}

export type WorkflowService = ReturnType<typeof createWorkflowService>
