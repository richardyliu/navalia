// OG-04 Quick Box intent routing. Pure: no node / electron imports (renderer-safe).
// Three modes: 快速问 (local memory search, same IPC as the Search page — no LLM call),
// 快速记 (same remember IPC as RememberDialog), 快速打开 (jump to a page in the main window).
// A leading prefix overrides the selected mode: `?` ask, `+` remember, `>` / `/` open.
import { QUICK_OPEN_PAGES, type QuickOpenPage } from './api'
import { tr } from '../../shared/i18n'

export type QuickMode = 'ask' | 'remember' | 'open'

export const QUICK_ASK_MAX = 2000 // = SearchArgs.query max in src/main/ipc.ts
export const QUICK_REMEMBER_MAX = 20_000 // = RememberArgs.content max in src/main/ipc.ts

export type QuickIntent =
  | { kind: 'ask'; query: string }
  | { kind: 'remember'; content: string }
  | { kind: 'open'; page: QuickOpenPage; candidates: QuickOpenPage[] }
  | { kind: 'invalid'; mode: QuickMode; reason: string }

const PREFIX: Record<string, QuickMode> = { '?': 'ask', '？': 'ask', '+': 'remember', '＋': 'remember', '>': 'open', '/': 'open' }

export function splitPrefix(mode: QuickMode, raw: string): { mode: QuickMode; text: string } {
  const text = raw.trim()
  const m = PREFIX[text.charAt(0)]
  if (m) return { mode: m, text: text.slice(1).trim() }
  return { mode, text }
}

/** Ranked page matches for 快速打开. Empty query → all pages in nav order. */
export function matchPages(query: string): QuickOpenPage[] {
  const q = query.trim().toLowerCase()
  if (!q) return QUICK_OPEN_PAGES.map((p) => p.id)
  const scored: Array<{ id: QuickOpenPage; score: number; idx: number }> = []
  QUICK_OPEN_PAGES.forEach((p, idx) => {
    const names = [p.id, p.label.toLowerCase(), ...p.aliases.map((a) => a.toLowerCase())]
    let score = 0
    if (p.id === q || p.label.toLowerCase() === q) score = 4
    else if (names.some((n) => n === q)) score = 3
    else if (names.some((n) => n.startsWith(q))) score = 2
    else if (names.some((n) => n.includes(q))) score = 1
    if (score > 0) scored.push({ id: p.id, score, idx })
  })
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
  return scored.map((s) => s.id)
}

export function routeQuickInput(selected: QuickMode, raw: string): QuickIntent {
  const { mode, text } = splitPrefix(selected, raw)
  if (mode === 'open') {
    const candidates = matchPages(text)
    if (candidates.length === 0) return { kind: 'invalid', mode, reason: tr(`No page matches “${text}”`, `没有匹配“${text}”的页面`) }
    return { kind: 'open', page: candidates[0], candidates }
  }
  if (!text) return { kind: 'invalid', mode, reason: mode === 'ask' ? tr('Enter something to search for', '请输入要搜索的内容') : tr('Enter something to remember', '请输入要记住的内容') }
  if (mode === 'ask') {
    if (text.length > QUICK_ASK_MAX) return { kind: 'invalid', mode, reason: tr(`Search text too long (max ${QUICK_ASK_MAX} chars)`, `搜索内容过长（最多 ${QUICK_ASK_MAX} 字）`) }
    return { kind: 'ask', query: text }
  }
  if (text.length > QUICK_REMEMBER_MAX) return { kind: 'invalid', mode, reason: tr(`Content too long (max ${QUICK_REMEMBER_MAX} chars)`, `内容过长（最多 ${QUICK_REMEMBER_MAX} 字）`) }
  return { kind: 'remember', content: text }
}
