// S1-FULL C3 — context bundle for Lens Chat. Gathers candidate items from the LOCAL Runtime
// through the existing read paths (MCP tools via `ossTool`, REST `/model/graph` via `runtime()`),
// ranks, caps, truncates and redacts them. Nothing here touches the network beyond the local
// Runtime, and nothing here reads Runtime files directly (no index.db, no screenshots).
//
// Never included: screenshots / image data, file paths into the Runtime root, tokens / secrets
// (known Runtime secrets verbatim, then import/redact.ts `stripSecrets` + extra PII rules below).
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { BehaviorPatterns, CaptureSearchHit, MemorySearchHit, ModelGraphResponse } from '../../shared/types'
import { stripSecrets } from '../import/redact'
import { aggregateEntities, parseEntityGraph } from '../library/aggregate'
import { scrubKnownSecrets } from '../mcp/known-secrets'
import { CHAT_LIMITS, type ChatContextItem, type ContextKind } from './chat-api'

export interface ContextSourceDeps {
  ossTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Optional REST client (only `modelGraph` is used). */
  runtime?: () => { modelGraph(): Promise<ModelGraphResponse> }
  knownSecrets?: () => string[]
  now?: () => Date
}

export interface ContextCandidate {
  kind: ContextKind
  title: string
  text: string
  ref: string | null
  score: number
}

export interface GatherResult {
  candidates: ContextCandidate[]
  warnings: string[]
  /** True when every Runtime source failed (preview must be empty, never faked). */
  unreachable: boolean
}

export const TRUNCATION_MARKER = (original: number): string => `\n…［已截断，原文 ${original} 字］`

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

/** Applied BEFORE stripSecrets (its base64 rule would otherwise leave a `data:image/…;base64,` stub). */
const PRE_RULES: Array<[RegExp, string]> = [[/data:image\/[a-z0-9.+-]{1,32};base64,[A-Za-z0-9+/=\s]*/gi, '[图片已省略]']]

/** All bounded ({0,512}) so a long run without spaces stays linear. */
const EXTRA_RULES: Array<[RegExp, string]> = [
  // Paths into the Runtime root / its database / screenshots, absolute or ~-relative.
  [/(?:~|\/(?:Users|home|private|var|tmp|Volumes)\/)[^\s"'<>，。）)]{0,512}?\.persome[^\s"'<>，。）)]{0,512}/g, '[path]'],
  [/(?:[~/][^\s"'<>，。（(]{0,512})?\bindex\.db\b/g, '[path]'],
  [/[~/][^\s"'<>，。（(]{0,512}?\.(?:png|jpe?g|heic|webp|gif|tiff?)\b/gi, '[图片路径已省略]'],
  // Chinese mobile numbers and 18-digit resident ID numbers (het/redact covers +… and 3-3-4).
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[phone]'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[id-number]']
]

export interface Redacted {
  text: string
  redactions: number
  /** The whole text looked like an env / credential dump and was replaced. */
  dropped: boolean
}

/** Known secrets verbatim → stripSecrets (secrets, emails, home paths, …) → extra rules above. */
export function redactForCloud(input: string, known: readonly string[] = []): Redacted {
  const k = scrubKnownSecrets(input, known)
  let extra = 0
  let pre = k.text
  for (const [re, rep] of PRE_RULES) {
    pre = pre.replace(re, () => {
      extra++
      return rep
    })
  }
  const s = stripSecrets(pre)
  if (s.dropped) return { text: '', redactions: s.redactions + k.count + extra, dropped: true }
  let out = s.text
  for (const [re, rep] of EXTRA_RULES) {
    out = out.replace(re, () => {
      extra++
      return rep
    })
  }
  return { text: out, redactions: k.count + s.redactions + extra, dropped: false }
}

// ---------------------------------------------------------------------------------------------
// Question analysis
// ---------------------------------------------------------------------------------------------

const RECENCY_RE = /这周|本周|这星期|这个星期|最近|近期|这几天|今天|昨天|this week|recent|lately|today|yesterday/i

export function asksRecency(question: string): boolean {
  return RECENCY_RE.test(question)
}

/** Monday 00:00 (local time) of the week containing `now`. */
export function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - dow)
  return d
}

/** Latin words (≥ 2 chars, lowercased) + CJK bigrams. */
export function keywords(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? []) out.add(w)
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/** Fraction (0..1) of question keywords present in `text`. */
export function overlap(qk: readonly string[], text: string): number {
  if (qk.length === 0) return 0
  const t = text.toLowerCase()
  let hit = 0
  for (const k of qk) if (t.includes(k)) hit++
  return hit / qk.length
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

const SearchPayload = z.object({ results: z.array(z.unknown()).optional() }).passthrough()
const RecentPayload = z.object({ entries: z.array(z.unknown()).optional() }).passthrough()

function asHit(raw: unknown): MemorySearchHit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.content !== 'string' || !r.content.trim()) return null
  return {
    id: typeof r.id === 'string' ? r.id : '',
    path: typeof r.path === 'string' ? r.path : '',
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : undefined,
    content: r.content
  }
}

/** Memory file name only (`project-foo.md`), never the directory part. */
export function memoryLabel(p: string): string {
  const base = p.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return base.replace(/\.md$/i, '')
}

function hitTitle(prefix: string, h: MemorySearchHit): string {
  const label = memoryLabel(h.path)
  const when = h.timestamp ? h.timestamp.slice(0, 16).replace('T', ' ') : ''
  return [prefix, label, when].filter(Boolean).join(' · ')
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

// UI only (warnings); getters so the label follows the current locale.
const SOURCE_LABEL = {
  get search() {
    return tr('Memory search', '记忆搜索')
  },
  get behavior_patterns() {
    return tr('Profile / behavior patterns / workflows', '画像 / 行为规律 / 工作流')
  },
  get model_graph() {
    return tr('Model (people / projects / Points)', '模型（人 / 项目 / Point）')
  },
  get entity_graph() {
    return tr('People / project relations', '人物 / 项目关系')
  },
  get recent_activity() {
    return tr('Recent activity', '最近动态')
  }
} satisfies Record<string, string>

/**
 * Collect candidates from every source independently. A failing source adds a warning; if every
 * source fails the result is empty with `unreachable: true` (never fake items).
 */
export async function gatherContext(question: string, deps: ContextSourceDeps): Promise<GatherResult> {
  const now = (deps.now ?? (() => new Date()))()
  const qk = keywords(question)
  const out: ContextCandidate[] = []
  const warnings: string[] = []
  let attempted = 0
  let failed = 0

  async function source(name: keyof typeof SOURCE_LABEL, fn: () => Promise<void>): Promise<void> {
    attempted++
    try {
      await fn()
    } catch {
      failed++
      warnings.push(tr(`Could not read "${SOURCE_LABEL[name]}", so it was left out of the context`, `「${SOURCE_LABEL[name]}」读取失败，这部分没有放进上下文`))
    }
  }

  const memory = source('search', async () => {
    const payload = SearchPayload.parse(parseJson(await deps.ossTool('search', { query: question, top_k: 12 })))
    const hits = (payload.results ?? []).map(asHit).filter((h): h is MemorySearchHit => h !== null)
    hits.forEach((h, i) => out.push({ kind: 'memory', title: hitTitle('记忆', h), text: h.content, ref: h.id || null, score: 100 - i * 3 }))
  })

  const patterns = source('behavior_patterns', async () => {
    const p = parseJson(await deps.ossTool('behavior_patterns', {})) as Partial<BehaviorPatterns>
    if (p.root?.signature) out.push({ kind: 'model', title: '画像（Root）', text: p.root.signature, ref: null, score: 92 })
    const faces = Array.isArray(p.faces) ? [...p.faces].sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0)).slice(0, 12) : []
    for (const f of faces) {
      if (!f?.signature) continue
      out.push({
        kind: 'model',
        title: `行为规律（观察 ${f.observations ?? 0} 次）`,
        text: f.signature,
        ref: null,
        score: 40 + 50 * overlap(qk, f.signature)
      })
    }
    const skills = Array.isArray(p.skills) ? p.skills.slice(0, 20) : []
    for (const s of skills) {
      const body = [s.description, s.playbook].filter((x) => typeof x === 'string' && x.trim()).join('\n\n')
      if (!body) continue
      out.push({
        kind: 'workflow',
        title: `工作流 · ${memoryLabel(s.path ?? '') || '未命名'}`,
        text: body,
        ref: s.entry_id ?? (memoryLabel(s.path ?? '') || null),
        score: 25 + 60 * overlap(qk, body)
      })
    }
  })

  const graph = deps.runtime
    ? source('model_graph', async () => {
        const g = await deps.runtime!().modelGraph()
        const points = (g.model?.points ?? []).filter((pt) => pt.is_latest !== false && typeof pt.content === 'string')
        const scored = points
          .map((pt) => ({ pt, o: overlap(qk, pt.content) }))
          .filter((x) => x.o > 0)
          .sort((a, b) => b.o - a.o)
          .slice(0, 10)
        for (const { pt, o } of scored) {
          out.push({ kind: 'model', title: `Point · ${memoryLabel(pt.file_name ?? '') || pt.layer || '模型'}`, text: pt.content, ref: pt.receipt || pt.id || null, score: 35 + 50 * o })
        }
        // Entities whose name appears in the question → entity_graph (depth 1, no shadow edges).
        const agg = aggregateEntities(g)
        const lowerQ = question.toLowerCase()
        const names = [...agg.people, ...agg.projects]
          .map((e) => e.name)
          .filter((n) => n.trim().length >= 2 && lowerQ.includes(n.toLowerCase()))
          .slice(0, 5)
        for (const name of names) {
          await source('entity_graph', async () => {
            const eg = parseEntityGraph(await deps.ossTool('entity_graph', { name, depth: 1 }))
            if (!eg.resolved) return
            const lines = eg.edges.slice(0, 40).map((e) => `${e.src} —${e.label ?? e.predicate}→ ${e.dst}${e.observations ? `（${e.observations} 次）` : ''}`)
            if (eg.chainToUser) lines.unshift(`与你的关系：${eg.chainToUser}`)
            if (lines.length === 0) return
            out.push({ kind: 'entity', title: `关系 · ${eg.resolved}`, text: lines.join('\n'), ref: eg.resolved, score: 96 })
          })
        }
      })
    : Promise.resolve()

  const recency = asksRecency(question)
  const recent = source('recent_activity', async () => {
    const args: Record<string, unknown> = recency ? { since: startOfWeek(now).toISOString(), limit: 30 } : { limit: 6 }
    const payload = RecentPayload.parse(parseJson(await deps.ossTool('recent_activity', args)))
    const hits = (payload.entries ?? []).map(asHit).filter((h): h is MemorySearchHit => h !== null)
    hits.forEach((h, i) =>
      out.push({ kind: 'recent', title: hitTitle('最近', h), text: h.content, ref: h.id || null, score: recency ? 85 - i : 15 - i * 0.5 })
    )
  })

  await Promise.all([memory, patterns, graph, recent])
  const unreachable = attempted > 0 && failed === attempted
  if (unreachable) {
    return { candidates: [], warnings: [
        tr(
          'Cannot reach the local Persome Runtime: no context was added (nothing is made up). You can send just the question, or start the Runtime and preview again.',
          '连不上本机 Persome Runtime：没有放入任何上下文（不会编造条目）。可以只发送问题，或先启动 Runtime 再预览。'
        )
      ], unreachable: true }
  }
  return { candidates: out, warnings, unreachable: false }
}

// ---------------------------------------------------------------------------------------------
// Bundle building (rank → dedupe → redact → truncate → cap → ids)
// ---------------------------------------------------------------------------------------------

export interface BundleOptions {
  maxItems?: number
  maxTotalChars?: number
  maxItemChars?: number
  knownSecrets?: readonly string[]
}

export interface Bundle {
  items: ChatContextItem[]
  totalChars: number
  warnings: string[]
}

function clip(text: string, max: number, original: number = text.length): string {
  if (text.length <= max && original <= text.length) return text
  const marker = TRUNCATION_MARKER(original)
  return text.slice(0, Math.max(0, max - marker.length)) + marker
}

export function buildBundle(candidates: readonly ContextCandidate[], opts: BundleOptions = {}): Bundle {
  const maxItems = Math.min(opts.maxItems ?? CHAT_LIMITS.defaultMaxItems, CHAT_LIMITS.maxItems)
  const maxTotal = Math.min(opts.maxTotalChars ?? CHAT_LIMITS.maxTotalChars, CHAT_LIMITS.maxTotalChars)
  const maxItem = Math.min(opts.maxItemChars ?? CHAT_LIMITS.maxItemChars, CHAT_LIMITS.maxItemChars)
  const known = opts.knownSecrets ?? []
  const warnings: string[] = []

  // Stable sort by score desc (ties keep source order).
  const ranked = candidates.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i)

  const seen = new Set<string>()
  const items: ChatContextItem[] = []
  let total = 0
  let truncated = 0
  let droppedSecrets = 0
  let overBudget = 0
  for (const { c } of ranked) {
    const dedupeKey = c.ref ? `${c.kind}:${c.ref}` : `text:${c.text.trim().slice(0, 500)}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    if (items.length >= maxItems) {
      overBudget++
      continue
    }
    // Redact a bounded prefix only (cost stays linear in what can be sent); the marker reports
    // the original length.
    const raw = c.text.trim()
    const head = raw.length > maxItem + 2000 ? raw.slice(0, maxItem + 2000) : raw
    const body = redactForCloud(head, known)
    if (body.dropped || !body.text.trim()) {
      droppedSecrets++
      continue
    }
    const t = redactForCloud(c.title.trim() || c.kind, known)
    const title = clip(t.dropped ? c.kind : t.text.replace(/\s+/g, ' '), CHAT_LIMITS.maxTitleChars)
    const ref = c.ref ? redactForCloud(c.ref, known) : null
    let text = clip(body.text, maxItem, head === raw ? body.text.length : raw.length)
    if (text !== body.text) truncated++
    const room = maxTotal - total - title.length
    if (room < 200) {
      overBudget++
      continue
    }
    if (text.length > room) {
      text = clip(text, room, raw.length)
      truncated++
    }
    const chars = title.length + text.length
    total += chars
    items.push({
      id: `ctx-${items.length + 1}`,
      kind: c.kind,
      title,
      text,
      ref: ref && !ref.dropped && ref.text.length <= 512 ? ref.text : null,
      chars
    })
  }
  if (truncated > 0) warnings.push(tr(`${truncated} item(s) were too long and were truncated (marked 已截断)`, `${truncated} 条内容过长，已截断（标有「已截断」）`))
  if (overBudget > 0) warnings.push(tr(`${overBudget} more item(s) exceeded the limit (${maxItems} items / ${maxTotal} characters) and were left out`, `另有 ${overBudget} 条超出上限（${maxItems} 条 / ${maxTotal} 字符），没有放入`))
  if (droppedSecrets > 0) warnings.push(tr(`${droppedSecrets} item(s) looked like credentials / environment variables and were left out entirely`, `${droppedSecrets} 条疑似凭据 / 环境变量输出，已整体省略`))
  return { items, totalChars: total, warnings }
}

// ---------------------------------------------------------------------------------------------
// C7 — WeChat group digest candidates (capture kind; OCR / AX text only)
// ---------------------------------------------------------------------------------------------

export const WECHAT_BUNDLE_ID = 'com.tencent.xinWeChat'
const GENERIC_WECHAT_TITLES = new Set(['', '微信', 'wechat', 'weixin'])
export const WECHAT_UNKNOWN_GROUP = '未识别的会话（窗口标题只有「微信」）'

export function isWechatHit(h: Pick<CaptureSearchHit, 'app_name' | 'bundle_id'>): boolean {
  if (h.bundle_id) return h.bundle_id === WECHAT_BUNDLE_ID
  return /wechat|微信|weixin/i.test(h.app_name ?? '')
}

/** Group key from the window title (WeChat chat windows are titled with the chat / group name). */
export function wechatGroupOf(h: Pick<CaptureSearchHit, 'window_title'>): string {
  const t = (h.window_title ?? '').trim().replace(/\s*[-–—]\s*(微信|WeChat)\s*$/i, '').trim()
  return GENERIC_WECHAT_TITLES.has(t.toLowerCase()) ? WECHAT_UNKNOWN_GROUP : t
}

/** Snippet text without the FTS `[...]` highlight brackets. */
export function cleanSnippet(s: string): string {
  return s.replace(/\[([^\]\n]{0,200})\]/g, '$1').replace(/\s+/g, ' ').trim()
}

export interface WechatGather {
  candidates: ContextCandidate[]
  groups: number
  hits: number
  warnings: string[]
  unreachable: boolean
}

const CapturePayload = z.object({ results: z.array(z.unknown()).optional() }).passthrough()

function asCapture(raw: unknown): CaptureSearchHit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.file_stem !== 'string' || typeof r.snippet !== 'string') return null
  return {
    file_stem: r.file_stem,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    app_name: typeof r.app_name === 'string' ? r.app_name : '',
    bundle_id: typeof r.bundle_id === 'string' ? r.bundle_id : undefined,
    window_title: typeof r.window_title === 'string' ? r.window_title : undefined,
    snippet: r.snippet,
    focused_value_preview: typeof r.focused_value_preview === 'string' ? r.focused_value_preview : undefined
  }
}

/**
 * Search this week's captures for WeChat (app filter + text query), keep only WeChat hits, group
 * by chat title. Only `snippet` / focused-value text is used — never screenshots or frame paths.
 */
export async function gatherWechat(keyword: string | undefined, deps: ContextSourceDeps): Promise<WechatGather> {
  const now = (deps.now ?? (() => new Date()))()
  const since = startOfWeek(now).toISOString()
  const kw = keyword?.trim() || ''
  const calls: Array<Record<string, unknown>> = [
    { query: kw || '微信', app_name: 'WeChat', since, limit: 50 },
    { query: kw || '微信', app_name: '微信', since, limit: 50 },
    { query: kw ? `微信 ${kw}` : '微信', since, limit: 50 }
  ]
  const results = await Promise.allSettled(calls.map(async (args) => CapturePayload.parse(parseJson(await deps.ossTool('search_captures', args)))))
  if (results.every((r) => r.status === 'rejected')) {
    return { candidates: [], groups: 0, hits: 0, warnings: [tr('Cannot reach the local Persome Runtime: no screen captures were read (no group chats are made up).', '连不上本机 Persome Runtime：没有读取任何屏幕采集（不会编造群聊）。')], unreachable: true }
  }
  const warnings: string[] = []
  if (results.some((r) => r.status === 'rejected')) warnings.push(tr('Some capture searches failed, so results may be incomplete', '部分屏幕采集搜索失败，结果可能不完整'))
  const byStem = new Map<string, CaptureSearchHit>()
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const raw of r.value.results ?? []) {
      const h = asCapture(raw)
      if (!h || !isWechatHit(h)) continue
      if (h.timestamp && Date.parse(h.timestamp) < Date.parse(since)) continue
      byStem.set(h.file_stem, h)
    }
  }
  const groups = new Map<string, CaptureSearchHit[]>()
  for (const h of byStem.values()) {
    const g = wechatGroupOf(h)
    groups.set(g, [...(groups.get(g) ?? []), h])
  }
  const candidates: ContextCandidate[] = []
  for (const [name, hits] of groups) {
    hits.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const seenLines = new Set<string>()
    const lines: string[] = []
    for (const h of hits) {
      for (const part of [h.snippet, h.focused_value_preview ?? '']) {
        const line = cleanSnippet(part)
        if (!line || seenLines.has(line)) continue
        seenLines.add(line)
        lines.push(`[${h.timestamp.slice(5, 16).replace('T', ' ')}] ${line}`)
      }
    }
    if (lines.length === 0) continue
    candidates.push({
      kind: 'capture',
      title: `微信 · ${name}（${hits.length} 次采集）`,
      text: lines.join('\n'),
      ref: `capture:${hits[0].file_stem}`,
      score: name === WECHAT_UNKNOWN_GROUP ? hits.length : 1000 + hits.length
    })
  }
  if (candidates.length === 0) warnings.push(
      tr(
        'No WeChat content was found in this week\'s screen captures (WeChat may not have been open, OCR may be off, or capture was paused). There are no groups to summarize.',
        '这周的屏幕采集里没有找到微信内容（可能没打开微信、OCR 未开启，或采集已暂停）。没有可整理的群。'
      )
    )
  return { candidates, groups: candidates.length, hits: byStem.size, warnings, unreachable: false }
}
