/** S2-07 extraction panel + Playbook deep link view-model (pure, unit-tested; the .tsx stays thin). */
import type { ExtractSaveResult } from '../../../../main/workflows/api'
import { draftFieldSummary, parseExtraction, type ExtractSaveAs, type ExtractionForm } from '../../../../main/workflows/extract'
import { WorkflowIdSchema } from '../../../../main/workflows/schema'
import { tr } from '../../lib/i18n'

export const AGENT_OPTIONS = ['Claude Code', 'Codex', '其他'] as const
export type AgentOption = (typeof AGENT_OPTIONS)[number]

/** Display text for an agent choice (`其他` is the stable option value). */
export function agentOptionLabel(o: AgentOption): string {
  return o === '其他' ? tr('Other', '其他') : o
}

export const SAVE_AS_LABEL: Record<ExtractSaveAs, string> = {
  get user_edited() {
    return tr('Save as "Edited" (I have checked it)', '保存为「手动编辑」（我已核对过）')
  },
  get imported() {
    return tr('Save as "Imported" (not checked)', '保存为「导入」（未核对）')
  }
}

const FORM_LABEL: Record<ExtractionForm, string> = {
  get extraction() {
    return tr('Extraction JSON', '抽取 JSON')
  },
  get wrapped() {
    return tr('Wrapped format { workflow }', '包装格式 { workflow }')
  },
  get workflow() {
    return tr('Full Navalia Workflow (content and evidence only)', '完整 Navalia Workflow（只取内容与证据）')
  },
  get export() {
    return tr('Navalia export file (1 Workflow)', 'Navalia 导出文件（1 个 Workflow）')
  }
}

export interface ExtractPreview {
  status: 'empty' | 'invalid' | 'valid'
  errors: string[]
  formLabel: string | null
  title: string
  fields: Array<{ key: string; label: string; count: number }>
  /** Fields left empty — shown so the user sees nothing was filled in for them. */
  empty: string[]
}

export function extractPreview(text: string): ExtractPreview {
  if (!text.trim()) return { status: 'empty', errors: [], formLabel: null, title: '', fields: [], empty: [] }
  const r = parseExtraction(text)
  if (!r.ok) return { status: 'invalid', errors: r.errors, formLabel: null, title: '', fields: [], empty: [] }
  const fields = draftFieldSummary(r.draft)
  return {
    status: 'valid',
    errors: [],
    formLabel: FORM_LABEL[r.form],
    title: r.draft.title,
    fields,
    empty: fields.filter((f) => f.count === 0).map((f) => f.label)
  }
}

/** The agent label stored in provenance: a preset, or the user's own text for 其他. */
export function resolveAgent(choice: AgentOption, custom: string): string {
  return (choice === '其他' ? custom : choice).trim().slice(0, 100)
}

export function extractSaveSummary(r: ExtractSaveResult): string {
  if (r.item.outcome === 'duplicate')
    return tr(`Same content as the existing Workflow "${r.item.detail ?? r.item.id}"; not saved again`, `内容与已有的 Workflow「${r.item.detail ?? r.item.id}」相同，没有重复保存`)
  return tr(`Saved as ${r.item.id} "${r.item.title || '(untitled)'}"`, `已保存为 ${r.item.id}「${r.item.title || '（无标题）'}」`)
}

/** Playbook deep link: `go('playbook', { workflowId })` → a valid Workflow id, else null. */
export function workflowIdFromParams(params: Record<string, string> | undefined): string | null {
  const id = params?.workflowId
  return id && WorkflowIdSchema.safeParse(id).success ? id : null
}
