import { intlLocale } from '../../../shared/i18n'

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(intlLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function formatNumber(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(intlLocale()).format(value)
}

export function tagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag)).filter(Boolean)
  if (typeof tags === 'string') return tags.split(/[\s,]+/).filter(Boolean)
  return []
}

export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

export function confidence(value?: number | null): string {
  if (value == null) return '—'
  return `${Math.round(value * 100)}%`
}

export function statusTone(value?: string | null): 'ok' | 'warn' | 'bad' | 'muted' {
  if (!value) return 'muted'
  const normalized = value.toLowerCase()
  if (['ok', 'complete', 'active', 'running', 'granted', 'ready'].includes(normalized)) return 'ok'
  if (['degraded', 'unknown', 'paused', 'not_built', 'building', 'forming'].includes(normalized)) return 'warn'
  if (['denied', 'failed', 'error', 'unreachable'].includes(normalized)) return 'bad'
  return 'muted'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
