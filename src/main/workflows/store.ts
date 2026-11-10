/**
 * Local Workflow store: `<storeRoot>/workflows/<id>/v<NNNNNN>.json`, owner-only (0700 / 0600).
 *
 * Every version is kept. An observed Workflow from the Runtime is only copied into the store
 * when the user first edits it: v1 = the observed original (unchanged), v2 = the edit.
 */
import { tr } from '../../shared/i18n'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ensureSecureDir, writeFileSecure } from '../store/paths'
import type { ImportItem, ImportReport } from './api'
import { readRegularText } from './runtime'
import type { ExtractSaveAs, ExtractionDraft } from './extract'
import { changedFields } from './cloud-draft'
import {
  CONTENT_KEYS,
  WORKFLOW_EXPORT_FORMAT,
  WorkflowEditSchema,
  WorkflowExportSchema,
  WorkflowIdSchema,
  WorkflowSchema,
  emptyWorkflow,
  provenance,
  source,
  type ContentKey,
  type ExtractionMeta,
  type ProvenanceStep,
  type Workflow,
  type WorkflowEdit
} from './schema'

export type { ImportItem, ImportReport }

export interface SharedImportMeta {
  fileName: string
  sharedAt: string
  signerFingerprint: string
  packageHash: string
  chain: ProvenanceStep[]
}

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024

export class WorkflowError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string
  ) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** sha256 over the user-visible content fields in a fixed shape (key order independent). */
export function contentHash(w: Pick<Workflow, (typeof CONTENT_KEYS)[number]>): string {
  const shape = CONTENT_KEYS.map((k) => {
    if (k === 'steps') return w.steps.map((s) => [s.order, s.text])
    if (k === 'problems') return w.problems.map((p) => [p.problem, p.solution])
    return w[k]
  })
  return createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex')
}

const versionFile = (v: number) => `v${String(v).padStart(6, '0')}.json`

/** C15: union the edited fields into a cloud extraction record; other extraction records pass through. */
export function cloudEditMeta(meta: ExtractionMeta, changed: ContentKey[]): ExtractionMeta {
  if (meta.source !== 'cloud_extracted' || changed.length === 0) return meta
  const edited = new Set([...(meta.edited_fields ?? []), ...changed])
  const cites = meta.item_cites
  return {
    ...meta,
    edited_fields: CONTENT_KEYS.filter((k) => edited.has(k)),
    ...(cites
      ? {
          item_cites: {
            steps: changed.includes('steps') ? [] : cites.steps,
            artifacts: changed.includes('artifacts') ? [] : cites.artifacts,
            rules: changed.includes('rules') ? [] : cites.rules,
            problems: changed.includes('problems') ? [] : cites.problems
          }
        }
      : {})
  }
}

export function createWorkflowStore(storeRoot: string, now: () => Date = () => new Date()) {
  const dir = path.join(storeRoot, 'workflows')

  function idDir(id: string): string {
    return path.join(dir, WorkflowIdSchema.parse(id))
  }

  function readVersionFile(file: string): Workflow | null {
    try {
      const text = readRegularText(file, MAX_IMPORT_BYTES)
      if (text === null) return null
      const parsed = WorkflowSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** All stored versions of one id, oldest first. */
  function versions(id: string): Workflow[] {
    const d = idDir(id)
    let names: string[]
    try {
      names = fs.readdirSync(d).filter((n) => /^v\d{6}\.json$/.test(n)).sort()
    } catch {
      return []
    }
    return names.map((n) => readVersionFile(path.join(d, n))).filter((w): w is Workflow => w !== null && w.id === id)
  }

  function latest(id: string): Workflow | null {
    const all = versions(id)
    return all.length ? all[all.length - 1] : null
  }

  function ids(): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && WorkflowIdSchema.safeParse(d.name).success)
        .map((d) => d.name)
        .sort()
    } catch {
      return []
    }
  }

  function listLatest(): Workflow[] {
    return ids()
      .map(latest)
      .filter((w): w is Workflow => w !== null)
  }

  function write(w: Workflow): Workflow {
    const valid = WorkflowSchema.parse(w)
    ensureSecureDir(dir)
    ensureSecureDir(idDir(valid.id))
    const file = path.join(idDir(valid.id), versionFile(valid.version))
    if (fs.existsSync(file)) throw new WorkflowError('conflict', `version ${valid.version} of ${valid.id} already exists`)
    writeFileSecure(file, `${JSON.stringify(valid, null, 2)}\n`)
    return valid
  }

  /**
   * Manual edit. `baseVersion` must equal the current version (optimistic concurrency).
   * `observed` is the live Runtime-derived Workflow, needed only for the first edit of an
   * observed Workflow that is not in the store yet: it is kept unchanged as v1.
   */
  function saveEdit(id: string, baseVersion: number, edit: WorkflowEdit, observed: Workflow | null): { workflow: Workflow; unchanged: boolean } {
    let current = latest(id)
    if (!current) {
      if (!observed || observed.id !== id) throw new WorkflowError('not_found', `workflow not found: ${id}`)
      current = write({ ...observed, version: 1 })
    }
    if (baseVersion !== current.version) {
      throw new WorkflowError('conflict', `workflow ${id} is at version ${current.version}, edit was based on ${baseVersion}`)
    }
    // Strict parse here too, so no caller can overwrite evidence / provenance / id via `edit`.
    const candidate = { ...current, ...WorkflowEditSchema.parse(edit) }
    if (contentHash(candidate) === contentHash(current)) return { workflow: current, unchanged: true }
    const at = now().toISOString()
    const prev = current.provenance
    const next: Workflow = {
      ...candidate,
      version: current.version + 1,
      provenance: provenance('user_edited', {
        edited_at: at,
        based_on_version: current.version,
        observed_at: prev.observed_at,
        imported_at: prev.imported_at,
        from: prev.from,
        original_id: prev.original_id,
        original_version: prev.original_version,
        original_kind: prev.kind === 'user_edited' ? prev.original_kind : prev.kind,
        // S1-10: an edit of a shared Workflow keeps who signed it and the carried chain.
        shared_at: prev.shared_at,
        signer_fingerprint: prev.signer_fingerprint,
        package_hash: prev.package_hash,
        chain: prev.chain,
        // S2-07: an edit of an external-agent extraction keeps that record.
        // C15: a cloud extraction also records which fields the user changed (and drops the cite
        // alignment of an edited list field, since items may have moved).
        ...(prev.extraction ? { extraction: cloudEditMeta(prev.extraction, changedFields(current, candidate)) } : {})
      }),
      updated_at: at
    }
    return { workflow: write(next), unchanged: false }
  }

  /** Parse + validate an export file (envelope or a bare Workflow). Throws on anything invalid. */
  function parseImport(text: string): Workflow[] {
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new WorkflowError('invalid', `import file is larger than ${MAX_IMPORT_BYTES} bytes`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new WorkflowError('invalid', tr('Not a valid JSON file', '不是合法的 JSON 文件'))
    }
    const env = WorkflowExportSchema.safeParse(json)
    if (env.success) return env.data.workflows
    const one = WorkflowSchema.safeParse(json)
    if (one.success) return [one.data]
    const issues = (env.error as z.ZodError).issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new WorkflowError('invalid', tr(`Not a valid Workflow export file (${WORKFLOW_EXPORT_FORMAT}): ${issues.join('; ')}`, `不是合法的 Workflow 导出文件（${WORKFLOW_EXPORT_FORMAT}）：${issues.join('; ')}`))
  }

  /**
   * Import validated Workflows. Each lands as v1 with provenance `imported`; evidence refs are
   * kept but marked `origin: imported` (they point into the sender's model and may not resolve).
   * Dedupe: same content hash as anything stored or in `known` (e.g. live observed) → skipped.
   * Same id with different content → stored under `<id>~<hash8>`.
   */
  function importWorkflows(list: Workflow[], fileName: string, known: Workflow[] = []): ImportReport {
    const hashes = knownHashes(known)
    const items: ImportItem[] = []
    const at = now().toISOString()
    const from = path.basename(fileName).slice(0, 200)
    for (const w of list) {
      const h = contentHash(w)
      const dup = hashes.get(h)
      if (dup) {
        items.push({ id: w.id, title: w.title, outcome: 'duplicate', detail: dup })
        continue
      }
      // Never keep a foreign id: it could later shadow a Runtime-observed id (security review #2).
      const id = freshId('imp', h, known)
      const stored = write({
        ...w,
        id,
        version: 1,
        evidence: w.evidence.map((e) => ({ ...e, origin: 'imported' as const })),
        provenance: provenance('imported', {
          imported_at: at,
          from,
          observed_at: w.provenance.observed_at,
          original_id: w.id,
          original_version: w.version,
          original_kind: w.provenance.kind
        }),
        source: source('import_file', {
          path: w.source.path,
          entry_ids: w.source.entry_ids,
          stage: w.source.stage,
          confidence: w.source.confidence
        }),
        updated_at: at
      })
      hashes.set(h, stored.id)
      items.push({ id: stored.id, title: stored.title, outcome: 'imported', detail: id === w.id ? null : w.id })
    }
    return {
      file: from,
      items,
      imported: items.filter((i) => i.outcome === 'imported').length,
      duplicates: items.filter((i) => i.outcome === 'duplicate').length
    }
  }

  /**
   * S1-10: store one Workflow received in a verified `.navaliaskill` package as v1 with provenance
   * `shared`. The caller has already verified the signature. Dedupe: the same signed package
   * (package_hash) or the same content as anything stored / in `known` → reported as duplicate.
   */
  function importShared(w: Workflow, meta: SharedImportMeta, known: Workflow[] = []): ImportItem {
    const all = [...known, ...ids().flatMap(versions)]
    const samePackage = all.find((x) => x.provenance.package_hash === meta.packageHash)
    if (samePackage) return { id: w.id, title: w.title, outcome: 'duplicate', detail: samePackage.id }
    const h = contentHash(w)
    const sameContent = all.find((x) => contentHash(x) === h)
    if (sameContent) return { id: w.id, title: w.title, outcome: 'duplicate', detail: sameContent.id }
    // Never keep a foreign id (security review #2); original_id keeps the sender's id.
    const id = freshId('shr', h, known)
    const at = now().toISOString()
    const stored = write({
      ...w,
      id,
      version: 1,
      evidence: w.evidence.map((e) => ({ ...e, origin: 'imported' as const })),
      provenance: provenance('shared', {
        imported_at: at,
        from: path.basename(meta.fileName).slice(0, 200),
        observed_at: w.provenance.observed_at,
        original_id: w.id,
        original_version: w.version,
        original_kind: w.provenance.kind,
        shared_at: meta.sharedAt,
        signer_fingerprint: meta.signerFingerprint,
        package_hash: meta.packageHash,
        chain: meta.chain,
        ...(w.provenance.extraction ? { extraction: w.provenance.extraction } : {})
      }),
      source: source('share', {
        path: w.source.path,
        entry_ids: w.source.entry_ids,
        stage: w.source.stage,
        confidence: w.source.confidence
      }),
      updated_at: at
    })
    return { id: stored.id, title: stored.title, outcome: 'imported', detail: id === w.id ? null : w.id }
  }

  /** content hash → id for every stored version plus `known` (e.g. live observed). Shared dedupe for all imports. */
  function knownHashes(known: Workflow[]): Map<string, string> {
    const hashes = new Map<string, string>()
    for (const w of [...known, ...ids().flatMap(versions)]) hashes.set(contentHash(w), w.id)
    return hashes
  }

  /** A fresh `<prefix>-<hash12>` id that collides with nothing stored or known (never an observed `rt-*`). */
  function freshId(prefix: 'imp' | 'shr' | 'ext', h: string, known: Workflow[]): string {
    const taken = (x: string) => !!latest(x) || known.some((k) => k.id === x)
    const id = `${prefix}-${h.slice(0, 12)}`
    if (!taken(id)) return id
    const alt = `${id}~${h.slice(12, 20)}`
    if (!taken(alt)) return alt
    throw new WorkflowError('conflict', `id ${alt} already exists`)
  }

  /**
   * S2-07: store one Workflow drafted by an external agent and pasted back (Lens never calls an
   * LLM). Lands as v1 under a fresh `ext-<hash>` id — never an observed `rt-*` id or any existing
   * id. Provenance is `user_edited` or `imported` (the user's choice) plus an `extraction` record.
   * Evidence refs are kept verbatim but marked `origin: imported`: Lens has not verified them.
   * Dedupe: same content as anything stored or in `known` → duplicate, nothing written.
   */
  function saveExtracted(draft: ExtractionDraft, opts: { as: ExtractSaveAs; agent: string }, known: Workflow[] = []): ImportItem {
    const at = now().toISOString()
    const extraction: ExtractionMeta = { source: 'external_agent', agent: opts.agent.trim().slice(0, 100), extracted_at: at }
    if (!extraction.agent) throw new WorkflowError('invalid', tr('Enter the name of the agent used for extraction', '请填写抽取用的 agent 名称'))
    const prov =
      opts.as === 'imported'
        ? provenance('imported', { imported_at: at, from: extraction.agent, extraction })
        : provenance('user_edited', { edited_at: at, from: extraction.agent, extraction })
    const candidate: Workflow = {
      ...emptyWorkflow('ext-pending', prov, source('lens_store')),
      ...WorkflowEditSchema.parse({
        title: draft.title,
        goal: draft.goal,
        context: draft.context,
        inputs: draft.inputs,
        tools: draft.tools,
        steps: draft.steps,
        artifacts: draft.artifacts,
        rules: draft.rules,
        problems: draft.problems,
        tags: draft.tags
      }),
      evidence: draft.evidence.map((e) => ({ ref: e.ref, kind: e.kind, timestamp: e.timestamp ?? null, origin: 'imported' as const })),
      evidence_note: draft.evidence_note,
      created_at: at,
      updated_at: at
    }
    const h = contentHash(candidate)
    const dup = knownHashes(known).get(h)
    if (dup) return { id: dup, title: candidate.title, outcome: 'duplicate', detail: dup }
    const stored = write({ ...candidate, id: freshId('ext', h, known) })
    return { id: stored.id, title: stored.title, outcome: 'imported', detail: null }
  }

  /**
   * S1-FULL C15: store one cloud-drafted Workflow that the user reviewed in Lens. v1 under a fresh
   * `ext-<hash>` id, provenance kind `imported` (Lens did not observe it) + `extraction.source =
   * cloud_extracted` with the session ref, model, sent ids, cited item snapshots and edit markers.
   * No Runtime evidence refs: the cites point at the snapshots, not at Runtime entries.
   * Dedupe: same content as anything stored or in `known` → duplicate, nothing written.
   */
  function saveCloudExtracted(edit: WorkflowEdit, meta: ExtractionMeta, evidenceNote: string, known: Workflow[] = []): ImportItem {
    if (meta.source !== 'cloud_extracted') throw new WorkflowError('invalid', 'not a cloud extraction')
    const at = meta.extracted_at
    const candidate: Workflow = {
      ...emptyWorkflow('ext-pending', provenance('imported', { imported_at: now().toISOString(), from: meta.agent, extraction: meta }), source('lens_store')),
      ...WorkflowEditSchema.parse(edit),
      evidence_note: evidenceNote.slice(0, 4000),
      created_at: at,
      updated_at: now().toISOString()
    }
    if (candidate.steps.length === 0) throw new WorkflowError('invalid', tr('At least one step is needed to save', '至少需要一个步骤才能保存'))
    const h = contentHash(candidate)
    const dup = knownHashes(known).get(h)
    if (dup) return { id: dup, title: candidate.title, outcome: 'duplicate', detail: dup }
    const stored = write({ ...candidate, id: freshId('ext', h, known) })
    return { id: stored.id, title: stored.title, outcome: 'imported', detail: null }
  }

  function exportJson(list: Workflow[]): string {
    const env = WorkflowExportSchema.parse({ format: WORKFLOW_EXPORT_FORMAT, format_version: 1, exported_at: now().toISOString(), workflows: list })
    return `${JSON.stringify(env, null, 2)}\n`
  }

  return { dir, versions, latest, listLatest, saveEdit, parseImport, importWorkflows, importShared, saveExtracted, saveCloudExtracted, exportJson }
}
