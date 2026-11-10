import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
  CaptureDiagnosticsView,
  CaptureSource,
  CaptureStatusView,
  ConfigState,
  OcrConfigView,
  RuntimeConfigSummary,
  RuntimeOcrHealth,
  ValueOrigin
} from './api'
import { tr } from '../../shared/i18n'

export type {
  CaptureDiagnosticsView,
  CaptureSource,
  ConfigState,
  OcrConfigView,
  RuntimeConfigSummary,
  RuntimeOcrHealth,
  ValueOrigin
} from './api'

/**
 * S1-04 capture diagnostics: read-only parsing of the Runtime `config.toml`
 * `[capture]` table, OCR summary, and a copyable, redacted diagnostics block.
 * Pure functions except `readRuntimeConfigSummary` (one read-only file read)
 * and `fetchRuntimeOcrHealth` (unauthenticated loopback GET /health).
 *
 * Nothing here ever returns file contents, the bearer token, screenshot keys,
 * window titles, URLs or AX text.
 */

export type Scalar = string | number | boolean

/** OSS CaptureConfig defaults (personal-model src/persome/config.py, read-only reference). */
export const OSS_CAPTURE_DEFAULTS = {
  source: 'daemon',
  enable_ocr_fallback: false,
  ocr_policy: 'auto',
  ocr_tier: 'tiny'
} as const

const VALID_SOURCES = new Set(['daemon', 'ingest'])
const VALID_OCR_POLICIES = new Set(['auto', 'enabled', 'disabled'])
const VALID_OCR_TIERS = new Set(['tiny', 'small', 'medium'])
const MAX_CONFIG_BYTES = 1024 * 1024

export type CaptureTableParse =
  | { ok: true; hasCaptureSection: boolean; capture: Record<string, Scalar> }
  | { ok: false; error: string }

function stripComment(value: string): string {
  // Only called on the tail after a closed scalar/array; strings are handled before.
  const i = value.indexOf('#')
  return (i === -1 ? value : value.slice(0, i)).trim()
}

/** Index just past the closing quote of a basic/literal string starting at `start`, or -1. */
function closeQuote(s: string, start: number): number {
  const q = s[start]
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === q) return i + 1
  }
  return -1
}

function bracketDelta(s: string): { delta: number; ok: boolean } {
  let delta = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '#') break
    if (c === '"' || c === "'") {
      const end = closeQuote(s, i)
      if (end === -1) return { delta, ok: false }
      i = end - 1
      continue
    }
    if (c === '[' || c === '{') delta++
    else if (c === ']' || c === '}') delta--
  }
  return { delta, ok: true }
}

type ScalarParse = { ok: true; value: Scalar | undefined } | { ok: false }

/** Parse one TOML value we care about; arrays/tables/dates parse as `undefined` (present, not a scalar). */
function parseValue(raw: string): ScalarParse {
  const v = raw.trim()
  if (v === '') return { ok: false }
  if (v[0] === '"' || v[0] === "'") {
    const end = closeQuote(v, 0)
    if (end === -1) return { ok: false }
    if (stripComment(v.slice(end)) !== '') return { ok: false }
    const body = v.slice(1, end - 1)
    if (v[0] === "'") return { ok: true, value: body }
    try {
      return { ok: true, value: JSON.parse(`"${body}"`) as string }
    } catch {
      return { ok: true, value: body } // TOML escapes JSON lacks (\U, \e): keep raw, still valid
    }
  }
  const bare = stripComment(v)
  if (bare === 'true' || bare === 'false') return { ok: true, value: bare === 'true' }
  if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(bare)) return { ok: true, value: Number(bare.replace(/_/g, '')) }
  if (/^[+-]?(inf|nan)$/.test(bare) || /^0[xob][0-9a-fA-F_]+$/.test(bare)) return { ok: true, value: undefined }
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(bare)) return { ok: true, value: undefined }
  if (bare.startsWith('[') || bare.startsWith('{')) return { ok: true, value: undefined }
  return { ok: false }
}

/**
 * Conservative TOML reader: validates line structure of the whole file (so a
 * file `tomllib` would reject is reported as malformed rather than silently
 * read) and returns scalar keys of `[capture]`. Error messages carry only a
 * line number, never line content (other tables can hold API keys).
 */
export function parseCaptureTable(text: string): CaptureTableParse {
  if (text.includes('\u0000')) return { ok: false, error: tr('File contains binary content', '文件包含二进制内容') }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const seenTables = new Set<string>()
  const capture: Record<string, Scalar> = {}
  const captureKeys = new Set<string>()
  let section = ''
  let hasCaptureSection = false
  let multiString: '"""' | "'''" | null = null
  let arrayDepth = 0
  let multiStart = 0

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const lineNo = n + 1
    if (multiString) {
      if (line.includes(multiString)) multiString = null
      continue
    }
    if (arrayDepth > 0) {
      const d = bracketDelta(line)
      if (!d.ok) return { ok: false, error: tr(`Line ${lineNo}: unclosed string`, `第 ${lineNo} 行：字符串未闭合`) }
      arrayDepth += d.delta
      if (arrayDepth < 0) return { ok: false, error: tr(`Line ${lineNo}: mismatched brackets`, `第 ${lineNo} 行：括号不匹配`) }
      continue
    }
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    if (t.startsWith('[')) {
      const m = t.match(/^(\[\[?)\s*([A-Za-z0-9_.\-" ]+?)\s*(\]\]?)\s*(#.*)?$/)
      if (!m || m[1].length !== m[3].length) return { ok: false, error: tr(`Line ${lineNo}: malformed table header`, `第 ${lineNo} 行：表头格式错误`) }
      const name = m[2].replace(/\s+/g, '')
      const isArrayTable = m[1] === '[['
      if (!isArrayTable) {
        if (seenTables.has(name)) return { ok: false, error: tr(`Line ${lineNo}: table [${name === 'capture' ? 'capture' : '…'}] defined twice`, `第 ${lineNo} 行：表 [${name === 'capture' ? 'capture' : '…'}] 重复定义`) }
        seenTables.add(name)
      }
      section = isArrayTable ? `[[${name}]]` : name
      if (section === 'capture') hasCaptureSection = true
      continue
    }
    const kv = t.match(/^("[^"]*"|'[^']*'|[A-Za-z0-9_\-.]+)\s*=\s*(.*)$/)
    if (!kv) return { ok: false, error: tr(`Line ${lineNo}: cannot parse`, `第 ${lineNo} 行：无法解析`) }
    const rawValue = kv[2]
    if (rawValue.startsWith('"""') || rawValue.startsWith("'''")) {
      const delim = rawValue.slice(0, 3) as '"""' | "'''"
      if (!rawValue.slice(3).includes(delim)) {
        multiString = delim
        multiStart = lineNo
      }
      if (section === 'capture') captureKeys.add(kv[1])
      continue
    }
    if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
      const d = bracketDelta(rawValue)
      if (!d.ok) return { ok: false, error: tr(`Line ${lineNo}: unclosed string`, `第 ${lineNo} 行：字符串未闭合`) }
      if (d.delta < 0) return { ok: false, error: tr(`Line ${lineNo}: mismatched brackets`, `第 ${lineNo} 行：括号不匹配`) }
      if (d.delta > 0) {
        arrayDepth = d.delta
        multiStart = lineNo
      }
      if (section === 'capture') {
        if (captureKeys.has(kv[1])) return { ok: false, error: tr(`Line ${lineNo}: duplicate [capture] key`, `第 ${lineNo} 行：[capture] 键重复`) }
        captureKeys.add(kv[1])
      }
      continue
    }
    const parsed = parseValue(rawValue)
    if (!parsed.ok) return { ok: false, error: tr(`Line ${lineNo}: malformed value`, `第 ${lineNo} 行：值格式错误`) }
    if (section === 'capture') {
      const key = kv[1].replace(/^["']|["']$/g, '')
      if (captureKeys.has(key)) return { ok: false, error: tr(`Line ${lineNo}: duplicate [capture] key`, `第 ${lineNo} 行：[capture] 键重复`) }
      captureKeys.add(key)
      if (parsed.value !== undefined) capture[key] = parsed.value
    }
  }
  if (multiString) return { ok: false, error: tr(`Line ${multiStart}: unclosed multi-line string`, `第 ${multiStart} 行：多行字符串未闭合`) }
  if (arrayDepth > 0) return { ok: false, error: tr(`Line ${multiStart}: unclosed array`, `第 ${multiStart} 行：数组未闭合`) }
  return { ok: true, hasCaptureSection, capture }
}



const UNKNOWN_OCR: OcrConfigView = {
  enabled: null,
  policy: null,
  tier: null,
  origin: { enabled: 'unknown', policy: 'unknown', tier: 'unknown' }
}

function unknownSummary(state: ConfigState, file: string, error: string | null): RuntimeConfigSummary {
  return { state, path: file, error, source: 'unknown', sourceOrigin: 'unknown', sourceInvalid: false, ocr: UNKNOWN_OCR, invalidKeys: [] }
}

/** Pure: summarise parsed config text. */
export function summarizeRuntimeConfig(text: string, file: string): RuntimeConfigSummary {
  const parsed = parseCaptureTable(text)
  if (!parsed.ok) return unknownSummary('malformed', file, parsed.error)
  const c = parsed.capture
  const invalidKeys: string[] = []

  let source: CaptureSource = OSS_CAPTURE_DEFAULTS.source
  let sourceOrigin: ValueOrigin = 'default'
  let sourceInvalid = false
  if ('source' in c) {
    sourceOrigin = 'config'
    if (typeof c.source === 'string' && VALID_SOURCES.has(c.source)) source = c.source as CaptureSource
    else {
      source = 'unknown'
      sourceInvalid = true
      invalidKeys.push('source')
    }
  }

  const pick = <T extends Scalar>(
    key: string,
    fallback: T,
    valid: (v: Scalar) => boolean
  ): { value: T | null; origin: ValueOrigin } => {
    if (!(key in c)) return { value: fallback, origin: 'default' }
    if (!valid(c[key])) {
      invalidKeys.push(key)
      return { value: null, origin: 'unknown' }
    }
    return { value: c[key] as T, origin: 'config' }
  }
  const enabled = pick<boolean>('enable_ocr_fallback', OSS_CAPTURE_DEFAULTS.enable_ocr_fallback, (v) => typeof v === 'boolean')
  const policy = pick<string>('ocr_policy', OSS_CAPTURE_DEFAULTS.ocr_policy, (v) => typeof v === 'string' && VALID_OCR_POLICIES.has(v))
  const tier = pick<string>('ocr_tier', OSS_CAPTURE_DEFAULTS.ocr_tier, (v) => typeof v === 'string' && VALID_OCR_TIERS.has(v))

  return {
    state: 'ok',
    path: file,
    error: null,
    source,
    sourceOrigin,
    sourceInvalid,
    ocr: {
      enabled: enabled.value,
      policy: policy.value,
      tier: tier.value,
      origin: { enabled: enabled.origin, policy: policy.origin, tier: tier.origin }
    },
    invalidKeys
  }
}

/** Read-only: tolerate a missing, unreadable, oversized or malformed config. */
export function readRuntimeConfigSummary(root: string): RuntimeConfigSummary {
  const file = path.join(root, 'config.toml')
  let text: string
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return unknownSummary('unreadable', file, tr('Not a regular file', '不是普通文件'))
    if (st.size > MAX_CONFIG_BYTES) return unknownSummary('unreadable', file, tr('File too large', '文件过大'))
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return unknownSummary('missing', file, null)
    return unknownSummary('unreadable', file, code ?? tr('Read failed', '读取失败'))
  }
  return summarizeRuntimeConfig(text, file)
}


const HealthSchema = z.object({
  ocr: z.string().max(64).optional(),
  ocr_enabled: z.boolean().optional(),
  ocr_tier: z.string().max(32).optional(),
  ocr_worker: z.string().max(64).optional()
})

/** Pure: accept `{ok,data}` envelope or bare object; anything else is null. */
export function parseRuntimeOcrHealth(payload: unknown): RuntimeOcrHealth | null {
  const body =
    payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: unknown }).data : payload
  const r = HealthSchema.safeParse(body)
  if (!r.success) return null
  const d = r.data
  if (d.ocr === undefined && d.ocr_enabled === undefined && d.ocr_tier === undefined) return null
  return { state: d.ocr ?? null, enabled: d.ocr_enabled ?? null, tier: d.ocr_tier ?? null, worker: d.ocr_worker ?? null }
}

/** Loopback only, no Authorization header (the route is the one unauthenticated Runtime endpoint). */
export async function fetchRuntimeOcrHealth(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500
): Promise<RuntimeOcrHealth | null> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    return parseRuntimeOcrHealth(await res.json())
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Diagnostics view + text


export function explainSource(config: RuntimeConfigSummary): string {
  if (config.state === 'missing') {
    return tr(
      "Runtime's config.toml was not found, so the capture source is unknown. By default the Runtime captures with its own daemon, and Navalia capture will not start.",
      '没有找到 Runtime 的 config.toml，无法确认采集来源（未知）。Runtime 缺省使用 daemon 自己采集，此时 Navalia 的采集不会启动。'
    )
  }
  if (config.state === 'unreadable') return tr("Cannot read Runtime's config.toml; capture source unknown. Navalia capture will not start.", '无法读取 Runtime 的 config.toml，采集来源未知；Navalia 的采集不会启动。')
  if (config.state === 'malformed') {
    return tr(
      "Runtime's config.toml is malformed; capture source unknown (the Runtime will also refuse to load it). Navalia capture will not start.",
      'Runtime 的 config.toml 格式有误，采集来源未知（Runtime 本身也会拒绝加载这个文件）；Navalia 的采集不会启动。'
    )
  }
  if (config.source === 'ingest') {
    return tr(
      "Capture source is ingest: Navalia reads the screen (Accessibility + Screen Recording are granted only to Navalia) and pushes each frame to the Runtime's /captures/ingest. The Runtime no longer captures on its own.",
      '采集来源是 ingest：由 Navalia 读取屏幕（辅助功能 + 屏幕录制只授予 Navalia），逐帧推送给 Runtime 的 /captures/ingest；Runtime 不再自己采集。'
    )
  }
  if (config.source === 'daemon') {
    const isDefault = config.sourceOrigin === 'default'
    return tr(
      `Capture source is daemon${isDefault ? ' (not set in config; using the default)' : ''}: the Runtime captures the screen itself, and Navalia capture stays off so nothing is captured twice. To let Navalia capture, set [capture] source to "ingest", restart the Runtime, then click "Restart capture".`,
      `采集来源是 daemon${isDefault ? '（配置里没有写，使用缺省值）' : ''}：Runtime 自己采集屏幕，Navalia 的采集保持停用、不会重复采集。要让 Navalia 采集，需要把 [capture] source 改为 "ingest" 并重启 Runtime，再点“重新启动采集”。`
    )
  }
  return tr(
    '[capture] source in config.toml is not "ingest" or "daemon"; capture source unknown (the Runtime will refuse to start). Navalia capture will not start.',
    'config.toml 里的 [capture] source 不是 "ingest" 或 "daemon"，采集来源未知（Runtime 会拒绝启动）；Navalia 的采集不会启动。'
  )
}

export function ocrLabel(config: RuntimeConfigSummary, runtime: RuntimeOcrHealth | null): string {
  const parts: string[] = []
  const { enabled, policy, tier } = config.ocr
  const unknown = tr('unknown', '未知')
  if (enabled === null) parts.push(tr('Config: unknown', '配置：未知'))
  else {
    const dflt = config.ocr.origin.enabled === 'default'
    parts.push(
      tr(
        `Config: ${enabled ? 'on' : 'off'}${dflt ? ' (default)' : ''}`,
        `配置：${enabled ? '开启' : '关闭'}${dflt ? '（缺省）' : ''}`
      )
    )
  }
  parts.push(tr(`policy ${policy ?? unknown}`, `策略 ${policy ?? unknown}`))
  parts.push(tr(`tier ${tier ?? unknown}`, `档位 ${tier ?? unknown}`))
  const live = runtime ? `${runtime.state ?? unknown}${runtime.tier ? ` / ${runtime.tier}` : ''}` : null
  parts.push(
    live !== null
      ? tr(`Runtime live: ${live}`, `Runtime 实时：${live}`)
      : tr('Runtime live: unknown (cannot reach /health)', 'Runtime 实时：未知（未连上 /health）')
  )
  return parts.join(' · ')
}

const SECRET_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi,
  /(bearer\s+)[^\s,;"']+/gi,
  /((?:token|api[_-]?key|secret|password|passwd|key)\s*[=:]\s*)["']?[^\s,;"']+["']?/gi,
  /(PERSOME_[A-Z_]*(?:TOKEN|KEY|SECRET)[A-Z_]*\s*=\s*)\S+/g
]

/**
 * Remove known secrets verbatim, then anything that looks like a credential:
 * `Bearer x`, `token=x`, `key: x`, and long opaque base64/hex runs.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text
  const mark = tr('[hidden]', '[已隐藏]')
  for (const s of knownSecrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join(mark)
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, prefix: string) => `${prefix ?? ''}${mark}`)
  // Opaque runs (tokens, keys) — require letters and digits so words/paths survive.
  out = out.replace(/[A-Za-z0-9_\-+=]{32,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? mark : m))
  return out
}

function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p
}

function permLabel(v: boolean): string {
  return v ? tr('granted', '已授权') : tr('not granted', '未授权')
}

function captureStateLine(s: CaptureStatusView): string {
  const reason = !s.started && s.reason ? s.reason : null
  return tr(
    `Capture state: ${s.started ? (s.degraded ? 'running (degraded)' : 'running') : 'not running'}${reason ? `; reason: ${reason}` : ''}`,
    `采集状态: ${s.started ? (s.degraded ? '运行中（降级）' : '运行中') : '未运行'}${reason ? `；原因: ${reason}` : ''}`
  )
}

function textHealthLine(h: NonNullable<CaptureStatusView['textHealth']>): string {
  const cov = h.coverage === null ? '—' : `${Math.round(h.coverage * 100)}%`
  return tr(
    `Text health (last ${h.windowMinutes} min): frames ${h.frames} / with text ${h.textFrames} (AX ${h.axTextFrames} / OCR screenshot ${h.ocrFrames}) / with pixels ${h.screenshotFrames}; coverage ${cov}; verdict ${h.verdict}`,
    `文本健康（近 ${h.windowMinutes} 分钟）: 帧 ${h.frames} / 有文本 ${h.textFrames}（AX ${h.axTextFrames} / OCR 截图 ${h.ocrFrames}）/ 带像素 ${h.screenshotFrames}；覆盖率 ${cov}；判定 ${h.verdict}`
  )
}

export interface BuildDiagnosticsInput {
  status: CaptureStatusView
  config: RuntimeConfigSummary
  runtimeOcr: RuntimeOcrHealth | null
  now: number
  homeDir?: string
  knownSecrets?: readonly string[]
}

/** Pure: assemble the diagnostics view and its redacted text block. */
export function buildCaptureDiagnostics(input: BuildDiagnosticsInput): CaptureDiagnosticsView {
  const { status: s, config, runtimeOcr } = input
  const home = input.homeDir ?? os.homedir()
  const generatedAt = new Date(input.now).toISOString()
  const last = s.recentFrames[0] ?? null
  const accepted = s.ingest.written + s.ingest.deduped + s.ingest.skipped
  const exclusionSummary =
    s.excluded.bundleIds.length + s.excluded.appNames.length === 0
      ? tr(`No manual exclusions; ${s.excluded.builtIn.length} built-in`, `无手动排除；内置排除 ${s.excluded.builtIn.length} 项`)
      : tr(
          `Manually excluded ${s.excluded.bundleIds.length} bundle id(s), ${s.excluded.appNames.length} app name(s); ${s.excluded.builtIn.length} built-in`,
          `手动排除 ${s.excluded.bundleIds.length} 个 bundle id、${s.excluded.appNames.length} 个应用名；内置排除 ${s.excluded.builtIn.length} 项`
        )
  const pauseLine = !s.pause.paused
    ? tr('Not paused', '未暂停')
    : s.pause.until
      ? tr(`Paused until ${s.pause.until}`, `暂停到 ${s.pause.until}`)
      : tr(`Paused since ${s.pause.since ?? '?'} (until resumed manually)`, `从 ${s.pause.since ?? '?'} 起暂停（直到手动恢复）`)
  const lensCaptureEffective = config.state === 'ok' && config.source === 'ingest'
  const ocr = ocrLabel(config, runtimeOcr)

  const lines = [
    tr('Navalia capture diagnostics', 'Navalia 采集诊断'),
    tr(`Generated: ${generatedAt}`, `生成时间: ${generatedAt}`),
    `Runtime root: ${tildify(s.runtime.root, home)}  port: ${s.runtime.port}`,
    tr(
      `config.toml: ${config.state}${config.error ? ` (${config.error})` : ''}`,
      `config.toml: ${config.state}${config.error ? `（${config.error}）` : ''}`
    ),
    tr(
      `capture.source: ${config.source} (${config.sourceOrigin})${config.sourceInvalid ? ' invalid value' : ''}`,
      `capture.source: ${config.source}（${config.sourceOrigin}）${config.sourceInvalid ? ' 无效值' : ''}`
    ),
    config.invalidKeys.length
      ? tr(`Keys the Runtime will reject: ${config.invalidKeys.join(', ')}`, `Runtime 会拒绝的键: ${config.invalidKeys.join(', ')}`)
      : null,
    tr(
      `Navalia capture in effect: ${lensCaptureEffective ? 'yes (ingest)' : 'no'}`,
      `Navalia 采集是否生效: ${lensCaptureEffective ? '是（ingest）' : '否'}`
    ),
    `OCR: ${ocr}`,
    runtimeOcr?.worker ? `OCR worker: ${runtimeOcr.worker}` : null,
    captureStateLine(s),
    s.startedAt ? tr(`Started at: ${s.startedAt}`, `启动于: ${s.startedAt}`) : null,
    tr(
      `Native module: ${s.nativeLoaded ? 'loaded' : 'not loaded'}${s.nativePath ? ` (${tildify(s.nativePath, home)})` : ''}`,
      `原生模块: ${s.nativeLoaded ? '已加载' : '未加载'}${s.nativePath ? `（${tildify(s.nativePath, home)}）` : ''}`
    ),
    tr(
      `Permissions: Accessibility ${permLabel(s.permissions.accessibility)}; Screen Recording ${permLabel(s.permissions.screenRecording)}; AX observers ${s.accessibilityObservers ? 'yes' : 'no'}`,
      `权限: 辅助功能 ${permLabel(s.permissions.accessibility)}；屏幕录制 ${permLabel(s.permissions.screenRecording)}；AX 观察者 ${s.accessibilityObservers ? '有' : '无'}`
    ),
    tr(`Pause: ${pauseLine}`, `暂停: ${pauseLine}`),
    tr(`Exclusions: ${exclusionSummary}`, `排除: ${exclusionSummary}`),
    s.settingsError ? tr(`Navalia capture settings: ${s.settingsError}`, `Navalia 采集设置: ${s.settingsError}`) : null,
    last
      ? tr(
          `Last frame: ${last.at} ${last.appName || last.bundleId || '(unknown app)'} → ${last.outcome}`,
          `最近一帧: ${last.at} ${last.appName || last.bundleId || '(未知应用)'} → ${last.outcome}`
        )
      : tr('Last frame: none', '最近一帧: 无'),
    tr(
      `Frame counts (this launch): received ${accepted} (written ${s.ingest.written} / deduped ${s.ingest.deduped} / skipped ${s.ingest.skipped}); rejected ${s.ingest.rejected}; too large ${s.ingest.tooLarge}; parked ${s.ingest.parked}; retries ${s.ingest.retries}; queued ${s.ingest.queued}`,
      `帧计数（本次启动）: 已接收 ${accepted}（写入 ${s.ingest.written} / 去重 ${s.ingest.deduped} / 跳过 ${s.ingest.skipped}）；被拒 ${s.ingest.rejected}；超限 ${s.ingest.tooLarge}；暂存 ${s.ingest.parked}；重试 ${s.ingest.retries}；队列 ${s.ingest.queued}`
    ),
    tr(
      `Withdrawn: paused ${s.ingest.dropped.paused} / locked ${s.ingest.dropped.locked} / excluded ${s.ingest.dropped.excluded_app}`,
      `撤回: 暂停 ${s.ingest.dropped.paused} / 锁屏 ${s.ingest.dropped.locked} / 排除 ${s.ingest.dropped.excluded_app}`
    ),
    s.textHealth ? textHealthLine(s.textHealth) : null,
    s.textHealth?.lastShotIssue
      ? tr(
          `Last no-screenshot reason: ${s.textHealth.lastShotIssue.reason} (${s.textHealth.lastShotIssue.at})`,
          `最近无截图原因: ${s.textHealth.lastShotIssue.reason}（${s.textHealth.lastShotIssue.at}）`
        )
      : null,
    Object.keys(s.decisions).length
      ? (() => {
          const d = Object.entries(s.decisions)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
          return tr(`Scheduler decisions: ${d}`, `调度决策: ${d}`)
        })()
      : null
  ].filter((l): l is string => l !== null)

  return {
    generatedAt,
    config: { ...config, error: config.error === null ? null : redactSecrets(config.error, input.knownSecrets) },
    runtimeOcr,
    lensCaptureEffective,
    sourceExplanation: explainSource(config),
    ocrLabel: ocr,
    frames: {
      lastAt: last?.at ?? null,
      lastApp: last ? last.appName || last.bundleId || null : null,
      lastOutcome: last?.outcome ?? null,
      accepted,
      written: s.ingest.written,
      recentCount: s.recentFrames.length
    },
    exclusions: {
      bundleIds: s.excluded.bundleIds.length,
      appNames: s.excluded.appNames.length,
      builtIn: s.excluded.builtIn.length,
      summary: exclusionSummary
    },
    text: redactSecrets(lines.join('\n'), input.knownSecrets)
  }
}
