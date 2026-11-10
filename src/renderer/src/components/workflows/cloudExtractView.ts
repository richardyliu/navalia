/** S1-FULL C15 cloud extraction panel view-model (pure, unit-tested; CloudExtractPanel.tsx stays thin). */
import type { CloudExtractItem, CloudExtractStatus, CloudSaveResult, SessionSummary } from '../../../../main/workflows/api'
import { draftEditedFields, type CloudDraft } from '../../../../main/workflows/cloud-draft'
import type { ContentKey } from '../../../../main/workflows/schema'
import { CONTENT_KEY_LABEL } from './viewModel'
import { tr } from '../../lib/i18n'

export type DraftList = 'steps' | 'artifacts' | 'rules' | 'problems'

/** Banner for the disabled state; null when extraction can run. Upstream (Runtime) Workflows are unaffected. */
export function cloudGate(s: CloudExtractStatus | undefined): { ready: boolean; message: string | null } {
  if (!s) return { ready: false, message: tr('Reading cloud status…', '正在读取云端状态…') }
  if (s.reason) return { ready: false, message: tr(`${s.reason}. Workflows observed by Runtime are not affected.`, `${s.reason}。Runtime 观察到的 Workflow 不受影响。`) }
  return { ready: true, message: null }
}

export function sessionLabel(s: SessionSummary): string {
  const agent = s.agent === 'codex' ? 'Codex' : 'Claude Code'
  const when = s.endedAt ? s.endedAt.slice(0, 16).replace('T', ' ') : tr('time unknown', '时间未知')
  return tr(`${agent} · ${s.title} · ${when} · ${s.userTurns} turns`, `${agent} · ${s.title} · ${when} · ${s.userTurns} 轮`)
}

/** Default selection: every previewed item. */
export function allIds(items: readonly CloudExtractItem[]): string[] {
  return items.map((i) => i.id)
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}

export function selectedChars(items: readonly CloudExtractItem[], ids: readonly string[]): number {
  const set = new Set(ids)
  return items.filter((i) => set.has(i.id)).reduce((n, i) => n + i.chars, 0)
}

/** Move item `index` of a list by `delta` (−1 up / +1 down); out-of-range moves are no-ops. */
export function moveItem(d: CloudDraft, list: DraftList, index: number, delta: -1 | 1): CloudDraft {
  const arr = [...d[list]] as unknown[]
  const to = index + delta
  if (index < 0 || index >= arr.length || to < 0 || to >= arr.length) return d
  ;[arr[index], arr[to]] = [arr[to], arr[index]]
  return { ...d, [list]: arr }
}

export function removeItem(d: CloudDraft, list: DraftList, index: number): CloudDraft {
  return { ...d, [list]: (d[list] as unknown[]).filter((_, i) => i !== index) }
}

export function updateItem<L extends DraftList>(d: CloudDraft, list: L, index: number, patch: Partial<CloudDraft[L][number]>): CloudDraft {
  return { ...d, [list]: (d[list] as Array<CloudDraft[L][number]>).map((it, i) => (i === index ? { ...it, ...patch } : it)) }
}

/** A user-added item has no cites (it is the user's own content, marked as an edit on save). */
export function addItem(d: CloudDraft, list: DraftList): CloudDraft {
  const blank = { steps: { title: '', detail: '', cites: [] }, artifacts: { name: '', kind: '', cites: [] }, rules: { text: '', cites: [] }, problems: { text: '', resolution: '', cites: [] } }[list]
  return { ...d, [list]: [...(d[list] as unknown[]), blank] }
}

/** Fields that differ from what the cloud returned — the 「用户已编辑」 markers the save will record. */
export function editedLabels(original: CloudDraft, current: CloudDraft): string[] {
  return draftEditedFields(original, current).map((k: ContentKey) => CONTENT_KEY_LABEL[k])
}

/** Save is blocked (with a reason) while an item is blank or there is no step. */
export function draftProblem(d: CloudDraft): string | null {
  if (d.steps.length === 0) return tr('Keep at least one step', '至少保留一个步骤')
  if (d.steps.some((s) => !s.title.trim())) return tr('A step has an empty title', '有步骤的标题为空')
  if (d.artifacts.some((a) => !a.name.trim())) return tr('An artifact has an empty name', '有产出的名称为空')
  if (d.rules.some((r) => !r.text.trim())) return tr('A rule is empty', '有规则为空')
  if (d.problems.some((p) => !p.text.trim())) return tr('A problem is empty', '有问题为空')
  return null
}

/** Cite chips: `ctx-3 · 第 2 轮` (title of the sent item) — unknown ids are shown as-is. */
export function citeLabels(cites: readonly string[], sent: readonly CloudExtractItem[]): Array<{ id: string; title: string }> {
  return cites.map((id) => ({ id, title: sent.find((i) => i.id === id)?.title ?? id }))
}

export function cloudSaveSummary(r: CloudSaveResult): string {
  if (r.item.outcome === 'duplicate')
    return tr(`Same content as the existing Workflow "${r.item.detail ?? r.item.id}"; not saved again`, `内容与已有的 Workflow「${r.item.detail ?? r.item.id}」相同，没有重复保存`)
  const edited = r.editedFields.length
    ? tr(`; you edited: ${r.editedFields.map((k) => CONTENT_KEY_LABEL[k]).join(', ')}`, `；你改过：${r.editedFields.map((k) => CONTENT_KEY_LABEL[k]).join('、')}`)
    : ''
  return tr(
    `Saved as ${r.item.id} "${r.item.title || '(untitled)'}", source: cloud extracted${edited}`,
    `已保存为 ${r.item.id}「${r.item.title || '（无标题）'}」，来源 云端抽取${edited}`
  )
}
