import { createHash } from 'node:crypto'
import { stripSecrets } from '../import/redact'
import type { ConnectorItem, CsvMapping } from './api'
import type { CsvTable } from './csv'
import { normalizeTime } from './health'
import { tr } from '../../shared/i18n'

/**
 * C19 generic CSV → one item per row from a user-chosen column mapping (date, title, body columns,
 * optional tags). Pure. Every written value is redacted (`stripSecrets`); unmapped columns are never
 * written. Row identity = hash of the mapped raw values (date + title + body), so re-importing the
 * same file is "unchanged"; a CSV has no stable row id, so an edited row is a new item.
 */

export const MAX_CSV_ITEMS = 20_000
const MAX_CELL = 2000
const MAX_TITLE = 300
const MAX_TAGS = 8

const norm = (h: string): string => h.trim().toLowerCase().replace(/[\s_-]+/g, '')
const DATE_NAMES = ['date', 'datetime', 'time', 'timestamp', 'created', 'createdat', 'when', 'day', '日期', '时间', '创建时间']
const TITLE_NAMES = ['title', 'subject', 'name', 'summary', 'headline', '标题', '主题', '名称']
const BODY_NAMES = ['body', 'text', 'content', 'note', 'notes', 'description', 'details', 'message', '内容', '正文', '备注', '描述']
const TAG_NAMES = ['tags', 'tag', 'labels', 'label', 'category', 'categories', '标签', '分类']

function find(header: string[], names: string[]): number | null {
  const n = header.map(norm)
  for (const want of names) {
    const i = n.indexOf(want)
    if (i >= 0) return i
  }
  return null
}

/** First guess; the user adjusts it in the preview. */
export function guessMapping(table: CsvTable): CsvMapping {
  const date = find(table.header, DATE_NAMES) ?? detectDateColumn(table)
  const title = find(table.header, TITLE_NAMES)
  const tags = find(table.header, TAG_NAMES)
  const bodyCol = find(table.header, BODY_NAMES)
  let body = bodyCol !== null ? [bodyCol] : []
  if (title === null && !body.length) {
    // Nothing recognisable: every non-date, non-tag column is body (the user can narrow it).
    body = table.header.map((_, i) => i).filter((i) => i !== date && i !== tags)
  }
  return { date, title, body: body.filter((i) => i !== title && i !== date), tags }
}

function detectDateColumn(t: CsvTable): number | null {
  const sample = t.rows.slice(0, 20)
  if (!sample.length) return null
  for (let c = 0; c < t.header.length; c++) {
    const ok = sample.filter((r) => r[c] && normalizeTime(r[c])).length
    if (ok >= Math.ceil(sample.length * 0.8)) return c
  }
  return null
}

export function validateMapping(m: CsvMapping, columns: number): string | null {
  const idx = [m.date, m.title, m.tags, ...m.body].filter((v): v is number => v !== null)
  if (idx.some((i) => !Number.isInteger(i) || i < 0 || i >= columns)) return tr('The column mapping is outside the CSV columns.', '列映射超出了 CSV 的列数。')
  if (m.title === null && !m.body.length) return tr('Choose at least a title column or one body column.', '至少要选择标题列或一个正文列。')
  if (new Set(m.body).size !== m.body.length) return tr('A body column is chosen twice.', '正文列有重复。')
  return null
}

export function sanitizeTags(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,;|，、；]/)) {
    const t = part.trim().toLowerCase().replace(/\s+/g, '-')
    if (!t || t.length > 40 || !/^[\p{L}\p{N}_.-]+$/u.test(t)) continue
    if (stripSecrets(t).redactions) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export interface CsvRowItem extends Omit<ConnectorItem, 'state'> {
  /** Extra Runtime tags for this row (`csv-tag:<x>`). */
  tags: string[]
}

export function csvItems(t: CsvTable, m: CsvMapping, fileLabel: string): { items: CsvRowItem[]; warnings: string[]; skipped: number } {
  const warnings = new Set<string>()
  const byKey = new Map<string, CsvRowItem>()
  let skipped = 0
  let badDates = 0
  const cell = (row: string[], i: number | null): string => (i === null ? '' : (row[i] ?? '').trim())
  const header = t.header.map((h) => stripSecrets(h.slice(0, 100)).text)
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r]
    const rawTitle = cell(row, m.title)
    const bodies = m.body.map((i) => [i, cell(row, i)] as const).filter(([, v]) => v)
    if (!rawTitle && !bodies.length) {
      skipped++
      continue
    }
    if (byKey.size >= MAX_CSV_ITEMS) {
      warnings.add(tr(`Previewing the first ${MAX_CSV_ITEMS} rows only; the rest are not imported`, `只预览前 ${MAX_CSV_ITEMS} 行，其余未导入`))
      break
    }
    let redactions = 0
    const c = (s: string, max: number): string => {
      const x = stripSecrets(s.length > max ? `${s.slice(0, max)}…` : s)
      redactions += x.redactions
      return x.text
    }
    const rawDate = cell(row, m.date)
    const time = rawDate ? normalizeTime(rawDate) : null
    if (rawDate && !time) badDates++
    if (time?.assumedLocal) warnings.add(tr('Some dates have no time zone and were read in the local time zone', '部分日期没有时区，已按本机时区解释'))
    const title = rawTitle ? c(rawTitle, MAX_TITLE) : c(bodies[0][1].split('\n')[0], 80)
    const lines = [`CSV 记录：${title}`]
    if (rawDate) lines.push(`时间：${time ? (time.dateOnly ? time.iso.slice(0, 10) : time.iso) : c(rawDate, 60)}`)
    for (const [i, v] of bodies) lines.push(m.body.length > 1 || m.title === null ? `${header[i] || `第 ${i + 1} 列`}：${c(v, MAX_CELL)}` : c(v, MAX_CELL))
    const tags = m.tags === null ? [] : sanitizeTags(cell(row, m.tags))
    if (tags.length) lines.push(`标签：${tags.join('、')}`)
    lines.push(`来源：${fileLabel} 第 ${r + 2} 行 · 本地 CSV，经 Navalia 连接器导入`)
    const identity = [rawDate, rawTitle, ...bodies.map(([i, v]) => `${i}\u0001${v}`)].join('\u0000')
    const key = `row-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
    if (byKey.has(key)) warnings.add(tr('The file has identical rows; only one is kept', '文件中有完全相同的行，只保留一行'))
    byKey.set(key, { key, title, when: time?.iso ?? null, text: lines.join('\n'), redactions, tags: tags.map((x) => `csv-tag:${x}`) })
  }
  if (badDates) warnings.add(tr(`${badDates} rows have an unreadable date; written as-is`, `${badDates} 行的日期无法识别，按原文写入`))
  if (skipped) warnings.add(tr(`${skipped} rows have nothing in the chosen columns and were skipped`, `${skipped} 行在所选列里没有内容，已跳过`))
  return { items: [...byKey.values()], warnings: [...warnings], skipped }
}
