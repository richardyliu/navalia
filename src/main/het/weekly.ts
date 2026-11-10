import { HET_DEFINITION, type HetAssessorStatus, type HetTaskDto } from './api'
import { hetPeriod, localDay } from './ledger'
import type { SqlDb } from './schema'

/**
 * Weekly Review (E3.6): local Markdown + HTML, nothing sent (DEVIATIONS D2).
 * Pure builder over the ledger; the caller writes the files. Invariant (throws if
 * violated): printed total == Σ printed counted rows == ledger period total.
 */

export const D2_FOOTER =
  'Local export (Navalia deviation D2): the original product delivers a cloud check-in / recap email. Navalia writes this file on this Mac and sends nothing.'

export interface WeeklyReview {
  weekStart: string
  weekEnd: string
  counted: HetTaskDto[]
  waiting: HetTaskDto[]
  excluded: HetTaskDto[]
  totalTenths: number
  markdown: string
  html: string
}

const fmt = (tenths: number): string => (tenths / 10).toFixed(1)
const day = (iso: string): string => localDay(Date.parse(iso))
const base = (p: string | null): string => (p ? p.split('/').filter(Boolean).pop() ?? p : '—')
/** Markdown-inert text: no tables broken, no links/images/HTML/code spans (finding #7). */
export const mdCell = (s: string): string => s.replace(/\s+/g, ' ').replace(/[\\|<>[\]!`*_]/g, (c) => `\\${c}`)
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function waitingReason(t: Pick<HetTaskDto, 'status' | 'last_error'>): string {
  if (t.status === 'unsettled') return 'session still active'
  if (t.status === 'failed') return 'assessment failed (gave up after max attempts)'
  const e = t.last_error ?? ''
  if (!e) return 'queued for assessment'
  if (e.startsWith('assessor_disabled')) return 'assessor disabled by the user setting (0 min)'
  if (e.startsWith('no_transport')) return 'no assessor transport in this build (0 min)'
  if (e.startsWith('budget_unavailable')) return 'assessor disabled / LLM budget unavailable'
  if (e.startsWith('quota')) return 'LLM quota exhausted; retries after reset'
  if (e.startsWith('offline')) return 'offline; retries later'
  if (e.startsWith('invalid')) return 'model output rejected as invalid; retries later'
  return 'assessment error; retries later'
}

/** S1-02: one-line export note when the assessor cannot produce minutes; null when it can. */
export function assessorNote(a: Pick<HetAssessorStatus, 'state'> | undefined): string | null {
  if (!a) return null
  if (a.state === 'disabled') return 'Assessor not enabled: tasks are recorded but count 0 min. This total is not a measurement.'
  if (a.state === 'no_transport') return 'Assessor enabled but this build has no assessor transport: tasks count 0 min. This total is not a measurement.'
  if (a.state === 'budget_unavailable') return 'Assessor budget unavailable: new tasks count 0 min until it is available.'
  if (a.state === 'fixture') return 'Test fixture assessor (not an LLM): minutes come from a fixture, for testing only.'
  return null
}

export function buildWeeklyReview(
  db: SqlDb,
  weekStartMs: number,
  generatedAt: number,
  assessor?: Pick<HetAssessorStatus, 'state'>
): WeeklyReview {
  const note = assessorNote(assessor)
  const weekEndMs = weekStartMs + 7 * 86_400_000
  const all: HetTaskDto[] = []
  let cursor: string | null = null
  let ledgerTotal = 0
  do {
    const p = hetPeriod(db, { start: weekStartMs, end: weekEndMs, cursor, limit: 200 })
    ledgerTotal = p.total_minutes_tenths
    all.push(...p.tasks)
    cursor = p.next_cursor
  } while (cursor)
  all.reverse() // chronological
  const counted = all.filter((t) => t.counted)
  const excluded = all.filter((t) => t.correction === 'rejected' || t.correction === 'not_agent')
  const waiting = all.filter((t) => !t.counted && !excluded.includes(t))
  const totalTenths = counted.reduce((a, t) => a + (t.minutes_tenths ?? 0), 0)
  if (totalTenths !== ledgerTotal) throw new Error(`weekly total mismatch: rows ${totalTenths} != ledger ${ledgerTotal}`)

  const ws = new Date(weekStartMs).toISOString()
  const we = new Date(weekEndMs - 1).toISOString()
  const head = ['Date', 'Agent', 'Project', 'Task', 'Kind', 'Adoption', 'Correction', 'HET min']
  const row = (t: HetTaskDto): string[] => [
    day(t.start),
    t.agent,
    base(t.project),
    t.title ?? '—',
    t.kind,
    t.adoption ?? '—',
    t.correction ?? '—',
    fmt(t.minutes_tenths ?? 0)
  ]

  const md: string[] = [
    '# Weekly Review — Human Equivalent Time',
    '',
    `Week: ${day(ws)} – ${day(we)} · generated ${new Date(generatedAt).toISOString()}`,
    '',
    `> ${HET_DEFINITION}`,
    '',
    `**Total: ${fmt(totalTenths)} min** across ${counted.length} assessed task(s).`,
    '',
    ...(note ? [`> **${note}**`, ''] : []),
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...counted.map((t) => `| ${row(t).map(mdCell).join(' | ')} |`),
    `| **Total** |  |  |  |  |  |  | **${fmt(totalTenths)}** |`,
    '',
    `## Waiting for assessment (${waiting.length}, 0 min, not counted)`,
    '',
    ...(waiting.length
      ? waiting.map((t) => `- ${day(t.start)} · ${t.agent} · ${mdCell(base(t.project))} · ${mdCell(t.title ?? '—')} — ${waitingReason(t)}`)
      : ['- none']),
    '',
    `## Excluded by you (${excluded.length}: rejected / not_agent, 0 min)`,
    '',
    ...(excluded.length ? excluded.map((t) => `- ${day(t.start)} · ${t.agent} · ${mdCell(base(t.project))} — ${t.correction}`) : ['- none']),
    '',
    '---',
    '',
    `_${D2_FOOTER}_`,
    ''
  ]

  const tr = (cells: string[], tag = 'td'): string => `<tr>${cells.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly Review ${esc(day(ws))}</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:32px auto;max-width:960px;padding:0 16px;color:#222;background:#fbfaf7}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}
td:last-child,th:last-child{text-align:right}tfoot td{font-weight:700}blockquote{color:#555;border-left:3px solid #ccc;margin:0;padding-left:12px}
footer{margin-top:32px;color:#777;font-size:12px}
</style></head><body>
<h1>Weekly Review — Human Equivalent Time</h1>
<p>Week: ${esc(day(ws))} – ${esc(day(we))} · generated ${esc(new Date(generatedAt).toISOString())}</p>
<blockquote>${esc(HET_DEFINITION)}</blockquote>
<p><strong>Total: ${esc(fmt(totalTenths))} min</strong> across ${counted.length} assessed task(s).</p>
${note ? `<p><strong>${esc(note)}</strong></p>
` : ''}<table><thead>${tr(head, 'th')}</thead><tbody>
${counted.map((t) => tr(row(t))).join('\n')}
</tbody><tfoot>${tr(['Total', '', '', '', '', '', '', fmt(totalTenths)])}</tfoot></table>
<h2>Waiting for assessment (${waiting.length}, 0 min, not counted)</h2>
<ul>${waiting.map((t) => `<li>${esc(`${day(t.start)} · ${t.agent} · ${base(t.project)} · ${t.title ?? '—'} — ${waitingReason(t)}`)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Excluded by you (${excluded.length}: rejected / not_agent, 0 min)</h2>
<ul>${excluded.map((t) => `<li>${esc(`${day(t.start)} · ${t.agent} · ${base(t.project)} — ${t.correction}`)}</li>`).join('') || '<li>none</li>'}</ul>
<footer>${esc(D2_FOOTER)}</footer>
</body></html>
`
  return { weekStart: ws, weekEnd: we, counted, waiting, excluded, totalTenths, markdown: md.join('\n'), html }
}
