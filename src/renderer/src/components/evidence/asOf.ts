/**
 * asOf view-model for the EvidenceDrawer (S1-03).
 *
 * Runtime `GET /model/evidence?as_of=` declares `as_of: datetime` (FastAPI + pydantic 2).
 * pydantic also accepts things we must NOT forward: `20260301` is parsed as a Unix epoch
 * (1970-08-23) and `2026-03-01 10:00` (space) is accepted. Lens narrows the contract to ISO
 * date (`YYYY-MM-DD`) or ISO datetime (`YYYY-MM-DDTHH:mm[:ss[.ffffff]][Z|±HH:MM]`).
 *
 * The same grammar is enforced in main (`isValidEvidenceAsOf` in src/main/runtime/client.ts);
 * tests/evidence/asOf.test.ts checks the two agree.
 */
import { tr } from '../../lib/i18n'

const AS_OF_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-](\d{2}):(\d{2}))?)?$/

export function asOfFormatHint(): string {
  return tr(
    'an ISO date (2026-03-01) or ISO datetime (2026-03-01T10:00, 2026-03-01T10:00:00+08:00)',
    'ISO 日期（2026-03-01）或 ISO 日期时间（2026-03-01T10:00、2026-03-01T10:00:00+08:00）'
  )
}

export type AsOfKind = 'date' | 'datetime_local' | 'datetime_offset'

export type AsOfCheck =
  | { ok: true; value: string | undefined; kind: AsOfKind | null }
  | { ok: false; error: string }

export function validateAsOf(input: string | null | undefined): AsOfCheck {
  const value = (input ?? '').trim()
  if (!value) return { ok: true, value: undefined, kind: null }
  const match = AS_OF_RE.exec(value)
  if (!match) return {
      ok: false,
      error: tr(
        `Invalid time format: "${value}". Use ${asOfFormatHint()}.`,
        `时间格式不合法：“${value}”。请使用 ${asOfFormatHint()}。`
      )
    }
  const [, y, mo, d, h, mi, s, , tz, tzh, tzm] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, error: tr(`No such date: "${value}".`, `日期不存在：“${value}”。`) }
  }
  if (h !== undefined) {
    if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) {
      return { ok: false, error: tr(`No such time: "${value}".`, `时间不存在：“${value}”。`) }
    }
  }
  if (tzh !== undefined && (Number(tzh) > 23 || Number(tzm) > 59)) {
    return { ok: false, error: tr(`Invalid time zone offset: "${value}".`, `时区偏移不合法：“${value}”。`) }
  }
  const kind: AsOfKind = h === undefined ? 'date' : tz ? 'datetime_offset' : 'datetime_local'
  return { ok: true, value, kind }
}

/** Human label for “which time is this evidence as of”. Never claims more than Runtime does. */
export function asOfLabel(asOf: string | undefined | null): string {
  const check = validateAsOf(asOf)
  if (!check.ok) return tr('As of: invalid time, request not sent', '截至：时间不合法，未发送请求')
  if (!check.value) return tr('As of: now (latest state)', '截至：现在（最新状态）')
  if (check.kind === 'date') {
    return tr(
      `As of ${check.value} 00:00 (local time zone; Runtime treats a bare date as midnight, so later content that day is excluded)`,
      `截至 ${check.value} 00:00（本机时区；Runtime 把纯日期当作当天零点，当天之后的内容不计入）`
    )
  }
  if (check.kind === 'datetime_local') {
    return tr(`As of ${check.value.replace('T', ' ')} (local time zone)`, `截至 ${check.value.replace('T', ' ')}（本机时区）`)
  }
  return tr(`As of ${check.value}`, `截至 ${check.value}`)
}

/**
 * MOD-12 (docs/upstream/MOD-12.md, DEVIATIONS): Runtime 0.3.2 `/model/evidence?as_of=T` cut only
 * successor links and nearby captures at T, by INGEST time; the object came back with its current
 * status. Runtime schema 2026-11-05.3 (commit 0249572) fixes this for Points and relation edges: the
 * status is computed AT T and `metadata.status_now` carries today's. Lens shows the old caveat unless
 * the response proves the Runtime computed the status at T; it never fabricates a historical status.
 */
export function asOfActionLabel(): string {
  return tr('View context up to then', '查看截止上下文')
}

export function asOfCaveatText(): string {
  return tr(
    'Context cut off by ingest time; not the state at that time. See MOD-12',
    '按录入时间截止的上下文，不等于当时状态；见 MOD-12'
  )
}

export function asOfStatusCaveatText(): string {
  return tr(
    'Runtime computed this status at the selected time (MOD-12 fixed in schema 2026-11-05.3); nearby context is still cut off by ingest time',
    'Runtime 已按所选时间计算这条的状态（MOD-12 已在 schema 2026-11-05.3 修复）；邻近上下文仍按录入时间截止'
  )
}

/** Caveat shown whenever an as-of cut-off is active (null for the live view). */
export function asOfCaveat(asOf: string | undefined | null, response?: { metadata?: Record<string, unknown> } | null): string | null {
  const check = validateAsOf(asOf)
  if (!check.ok || !check.value) return null
  return typeof response?.metadata?.status_now === 'string' ? asOfStatusCaveatText() : asOfCaveatText()
}

/** Value for an `<input type="datetime-local">` from an asOf string (date → midnight). */
export function toDateTimeLocalValue(asOf: string | undefined | null): string {
  const check = validateAsOf(asOf)
  if (!check.ok || !check.value) return ''
  if (check.kind === 'date') return `${check.value}T00:00`
  if (check.kind === 'datetime_local') return check.value.slice(0, 16)
  return ''
}
