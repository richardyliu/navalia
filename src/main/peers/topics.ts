// Pure helpers: card topics and deterministic term overlap. No I/O, no LLM, no clock.
import type { SignedCard } from '../identity/card-schema'
import type { ModelGraphResponse } from '../../shared/types'
import { UNVERIFIED, type PeerSuggestion, type PeerTopic } from './api'

const MAX_TOPICS = 24
const MAX_QUOTE = 160

export function clip(text: string, max = MAX_QUOTE): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What the card itself says (verbatim): Root summary, highlights, Mini Map volume/face labels. */
export function cardTopics(card: SignedCard): PeerTopic[] {
  const { front, back } = card.card.content
  const out: PeerTopic[] = []
  const seen = new Set<string>()
  const push = (source: PeerTopic['source'], text: string | null | undefined): void => {
    const t = clip(text ?? '')
    if (!t || seen.has(t) || out.length >= MAX_TOPICS) return
    seen.add(t)
    out.push({ source, text: t })
  }
  push('summary', front.summary)
  for (const h of front.highlights) push('highlight', h.signature)
  for (const n of back.mini_map.nodes) if (n.level !== 'root') push('map', n.label)
  return out
}

// ── Term extraction ────────────────────────────────────────────────────────────
// Latin: lowercased words of ≥3 chars minus a small stoplist.
// CJK: character bigrams inside CJK runs, skipping bigrams with function characters
// and a few generic words the Runtime uses in almost every signature.
const LATIN_STOP = new Set(
  'the and for with that this from are was were has have had about into their they them you your not but all can will its his her our out who what when how why use uses used using user users more most also than then very much many some such like just over only been being does did doing work works working'.split(
    ' '
  )
)
const CJK_FUNCTION = new Set('的了是在和与及或也都就把被为对从而以这那着过又很还更最等其之所于并且个们'.split(''))
const CJK_STOP = new Set(['用户', '一个', '进行', '使用', '相关', '通过', '主要', '经常', '喜欢', '倾向', '偏好', '习惯', '时候', '可以', '已经', '需要', '没有', '自己', '问题', '方面'])
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g
const LATIN_WORD = /[A-Za-z][A-Za-z0-9+#.-]*[A-Za-z0-9+#]|[A-Za-z]/g

export interface Terms {
  latin: Set<string>
  /** bigram → first index in the source text */
  cjk: Map<string, number>
}

export function extractTerms(text: string): Terms {
  const latin = new Set<string>()
  const cjk = new Map<string, number>()
  for (const m of String(text ?? '').matchAll(LATIN_WORD)) {
    const w = m[0].toLowerCase()
    if (w.length >= 3 && !LATIN_STOP.has(w)) latin.add(w)
  }
  for (const m of String(text ?? '').matchAll(CJK_RUN)) {
    const run = m[0]
    const base = m.index ?? 0
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (CJK_FUNCTION.has(bg[0]) || CJK_FUNCTION.has(bg[1]) || CJK_STOP.has(bg)) continue
      if (!cjk.has(bg)) cjk.set(bg, base + i)
    }
  }
  return { latin, cjk }
}

/**
 * Shared terms between a card line and a user line, as display phrases.
 * Adjacent shared bigrams are merged into the longest phrase that occurs verbatim in both lines.
 * Returns null unless the overlap is meaningful: ≥1 shared Latin word or ≥2 shared CJK bigrams.
 */
export function sharedTerms(peerText: string, peer: Terms, userText: string, user: Terms): string[] | null {
  const latin = [...peer.latin].filter((w) => user.latin.has(w)).sort()
  const cjkHits = [...peer.cjk.entries()].filter(([bg]) => user.cjk.has(bg)).sort((a, b) => a[1] - b[1])
  if (latin.length === 0 && cjkHits.length < 2) return null
  const phrases: string[] = []
  let i = 0
  while (i < cjkHits.length) {
    let j = i
    while (j + 1 < cjkHits.length && cjkHits[j + 1][1] === cjkHits[j][1] + 1) j++
    const phrase = peerText.slice(cjkHits[i][1], cjkHits[j][1] + 2)
    if (j > i && userText.includes(phrase)) phrases.push(phrase)
    else for (let k = i; k <= j; k++) phrases.push(cjkHits[k][0])
    i = j + 1
  }
  const out = [...new Set([...phrases, ...latin])]
  return out.length ? out : null
}

export interface UserLine {
  source: PeerSuggestion['userSource']
  text: string
  ref: string | null
  weight: number
}

const MAX_POINTS = 600

/** The user's own model lines, read-only from the Runtime graph. Superseded points are skipped. */
export function userLines(graph: ModelGraphResponse | null): UserLine[] {
  const model = graph?.model
  if (!model) return []
  const out: UserLine[] = []
  if (model.root?.signature) out.push({ source: 'root', text: model.root.signature, ref: null, weight: 3 })
  for (const v of Array.isArray(model.volumes) ? model.volumes : []) {
    if (v?.signature) out.push({ source: 'volume', text: v.signature, ref: null, weight: 2 })
  }
  for (const f of Array.isArray(model.faces) ? model.faces : []) {
    if (f?.signature) out.push({ source: 'face', text: f.signature, ref: null, weight: 2 })
  }
  const points = (Array.isArray(model.points) ? model.points : []).filter(
    (p) => p && typeof p.content === 'string' && p.content.trim() && p.is_latest !== false && p.status !== 'superseded'
  )
  for (const p of points.slice(0, MAX_POINTS)) {
    out.push({ source: 'point', text: p.content, ref: p.receipt || p.id || null, weight: 1 })
  }
  return out
}

const MAX_SUGGESTIONS = 6
const MAX_PER_TOPIC = 2

/**
 * Deterministic suggestions: one per (card line, user line) pair that shares terms.
 * Ranked by number of shared terms, then user-line weight, then text. Empty when nothing overlaps.
 */
export function suggestOverlap(topics: PeerTopic[], lines: UserLine[]): PeerSuggestion[] {
  const userTerms = lines.map((l) => ({ line: l, terms: extractTerms(l.text) }))
  const candidates: Array<PeerSuggestion & { score: number; weight: number; topicIndex: number }> = []
  topics.forEach((topic, topicIndex) => {
    const pt = extractTerms(topic.text)
    if (pt.latin.size === 0 && pt.cjk.size === 0) return
    const seenUser = new Set<string>()
    for (const { line, terms } of userTerms) {
      const shared = sharedTerms(topic.text, pt, line.text, terms)
      if (!shared) continue
      const userQuote = clip(line.text)
      if (seenUser.has(userQuote)) continue
      seenUser.add(userQuote)
      candidates.push({
        shared,
        peerQuote: topic.text,
        peerSource: topic.source,
        userQuote,
        userSource: line.source,
        userRef: line.ref,
        label: UNVERIFIED,
        score: shared.reduce((n, s) => n + Math.max(1, s.length - 1), 0),
        weight: line.weight,
        topicIndex
      })
    }
  })
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.weight - a.weight ||
      a.topicIndex - b.topicIndex ||
      a.userQuote.localeCompare(b.userQuote) ||
      (a.userRef ?? '').localeCompare(b.userRef ?? '')
  )
  const perTopic = new Map<string, number>()
  const out: PeerSuggestion[] = []
  for (const c of candidates) {
    const n = perTopic.get(c.peerQuote) ?? 0
    if (n >= MAX_PER_TOPIC) continue
    perTopic.set(c.peerQuote, n + 1)
    const { score: _s, weight: _w, topicIndex: _t, ...s } = c
    void _s
    void _w
    void _t
    out.push(s)
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out
}
