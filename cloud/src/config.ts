// Configuration is read from the environment once at startup. Tests build a
// CloudConfig directly (see test/helpers.ts) and never touch process.env.

export interface CloudConfig {
  /** TCP port; 0 = ephemeral (tests). */
  port: number
  /** Bind address. 127.0.0.1 by default; the Dockerfile sets 0.0.0.0. */
  host: string
  /** SQLite file path. */
  dbPath: string
  /** Audience bound into every auth signature. Must be a bare origin (scheme://host[:port]). */
  publicOrigin: string
  /** Bearer token lifetime in seconds. */
  tokenTtlS: number
  /** Auth challenge lifetime in seconds (contract: 300). */
  challengeTtlS: number
  /** Max request body in bytes (default 64 KiB). */
  bodyLimitBytes: number
  /** Fixed rate-limit window length in seconds. */
  rateWindowS: number
  /** Max requests per client IP per window. */
  rateIpMax: number
  /** Max requests per account (fingerprint) per window. */
  rateAccountMax: number
  /** When true, client IP = right-most X-Forwarded-For entry (set by our own reverse proxy). */
  trustProxy: boolean
  /** Chat LLM adapter. mode null = chat disabled (503 llm_unavailable). */
  llm: LlmConfig
  /** Per-account daily token budget (prompt + completion, UTC day). */
  chatDailyTokens: number
  /** Outgoing mail (C9). mode null = letters accepted, nothing sent (deliveries stay queued, error_code mail_disabled). */
  mail: MailConfig
  /**
   * Secret for HMAC-SHA256 of lowercased email addresses (suppression list, dedup) and for
   * unsubscribe tokens. null = generated once and stored in the DB (dev only; set it in production
   * so a DB leak alone cannot be used to brute-force addresses). Rotating it invalidates every
   * unsubscribe link already sent and every stored suppression hash.
   */
  emailPepper: string | null
  /** Max card fetches (GET /v1/cards/:fingerprint) per account per rate window. */
  cardFetchMax: number
  /** Max POST /v1/subscribe per client IP per hour. */
  subscribeIpPerHour: number
  /** Max POST /v1/subscribe per publisher per hour. */
  subscribePublisherPerHour: number
  /** Meetings speech-to-text (C13). mode null = meetings disabled (503 stt_unavailable). */
  stt: SttConfig
  /** Per-account daily audio budget in seconds (UTC day), counted when a chunk is accepted. */
  sttDailySeconds: number
  /** Directory for uploaded audio chunks (created 0700, files 0600, random names). */
  audioDir: string
  /** Max PUT /v1/meetings/:id/chunks/:seq per account per rate window. */
  meetingChunkRateMax: number
}

export type SttMode = 'soniox' | 'mock'

export interface SttConfig {
  mode: SttMode | null
  /** soniox mode: API key. Never logged, never returned, never in error messages. */
  sonioxApiKey: string
  /** soniox mode: API origin; the adapter calls `${base}/v1/files`, `${base}/v1/transcriptions`. */
  sonioxBaseUrl: string
  sonioxModel: string
  /** soniox mode: delay between transcription status polls. */
  pollIntervalMs: number
  /** soniox mode: max wall time for one chunk (upload + transcribe + fetch). */
  timeoutMs: number
  /** Max chunks transcribed concurrently. */
  concurrency: number
}

export const SONIOX_DEFAULT_BASE_URL = 'https://api.soniox.com'
export const SONIOX_DEFAULT_MODEL = 'stt-async-v6'

export const STT_DISABLED: SttConfig = {
  mode: null,
  sonioxApiKey: '',
  sonioxBaseUrl: SONIOX_DEFAULT_BASE_URL,
  sonioxModel: SONIOX_DEFAULT_MODEL,
  pollIntervalMs: 1000,
  timeoutMs: 180_000,
  concurrency: 2
}

export type MailMode = 'smtp' | 'outbox'

export interface SmtpConfig {
  host: string
  port: number
  /** true = implicit TLS (465). false = plain connect, STARTTLS required unless host is loopback. */
  secure: boolean
  user: string
  pass: string
}

export interface MailConfig {
  mode: MailMode | null
  /** Envelope/header From address (bare address; the display name is the publisher's). */
  from: string
  /** outbox mode: directory for .eml files (created 0700, files 0600). */
  outboxDir: string
  smtp: SmtpConfig
}

export const MAIL_DISABLED: MailConfig = { mode: null, from: '', outboxDir: '', smtp: { host: '', port: 587, secure: false, user: '', pass: '' } }

/** Conservative ASCII address check (no IDN, no quoted local parts, no CR/LF). */
export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export type LlmMode = 'openai' | 'mock'

export interface LlmConfig {
  mode: LlmMode | null
  /** openai mode: base URL without the trailing /chat/completions, e.g. https://api.openai.com/v1 */
  baseUrl: string
  /** openai mode: bearer key for the upstream. Never logged, never returned. Empty = no Authorization header. */
  apiKey: string
  model: string
  /** Idle timeout: max ms waiting for upstream headers or between upstream chunks. */
  timeoutMs: number
  /** max_tokens sent upstream. */
  maxTokens: number
}

export const LLM_DISABLED: LlmConfig = { mode: null, baseUrl: '', apiKey: '', model: '', timeoutMs: 60_000, maxTokens: 1500 }

export const DEFAULT_PORT = 8787

export class ConfigError extends Error {}

function int(env: Record<string, string | undefined>, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return dflt
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`)
  const n = Number(raw)
  if (n < min || n > max) throw new ConfigError(`${name} must be in [${min}, ${max}]`)
  return n
}

/** Returns the canonical origin or throws. Rejects paths, query, credentials, non-http(s). */
export function normalizeOrigin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConfigError('CLOUD_PUBLIC_ORIGIN must be an absolute URL origin')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('CLOUD_PUBLIC_ORIGIN must be http(s)')
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new ConfigError('CLOUD_PUBLIC_ORIGIN must be a bare origin (no path/query/credentials)')
  }
  if (raw.replace(/\/$/, '') !== u.origin) throw new ConfigError('CLOUD_PUBLIC_ORIGIN must be in canonical form, e.g. https://cloud.example.com')
  return u.origin
}

function loadLlm(env: Record<string, string | undefined>): LlmConfig {
  const rawMode = env.CLOUD_LLM_MODE ?? ''
  const timeoutMs = int(env, 'CLOUD_LLM_TIMEOUT_MS', 60_000, 1000, 600_000)
  const maxTokens = int(env, 'CLOUD_LLM_MAX_TOKENS', 1500, 1, 32_000)
  if (rawMode === '') return { ...LLM_DISABLED, timeoutMs, maxTokens }
  if (rawMode === 'mock') return { mode: 'mock', baseUrl: '', apiKey: '', model: env.CLOUD_LLM_MODEL || 'mock', timeoutMs, maxTokens }
  if (rawMode !== 'openai') throw new ConfigError('CLOUD_LLM_MODE must be "openai", "mock" or unset')
  const base = env.CLOUD_LLM_BASE_URL ?? ''
  let u: URL
  try {
    u = new URL(base)
  } catch {
    throw new ConfigError('CLOUD_LLM_BASE_URL must be an absolute http(s) URL in openai mode')
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new ConfigError('CLOUD_LLM_BASE_URL must be http(s) without credentials/query')
  }
  const model = env.CLOUD_LLM_MODEL ?? ''
  if (model === '') throw new ConfigError('CLOUD_LLM_MODEL is required in openai mode')
  return { mode: 'openai', baseUrl: base.replace(/\/+$/, ''), apiKey: env.CLOUD_LLM_API_KEY ?? '', model, timeoutMs, maxTokens }
}

function loadStt(env: Record<string, string | undefined>): SttConfig {
  const rawMode = env.CLOUD_STT_MODE ?? ''
  const common = {
    pollIntervalMs: int(env, 'CLOUD_STT_POLL_MS', 1000, 10, 60_000),
    timeoutMs: int(env, 'CLOUD_STT_TIMEOUT_MS', 180_000, 1000, 3_600_000),
    concurrency: int(env, 'CLOUD_STT_CONCURRENCY', 2, 1, 16)
  }
  if (rawMode === '') return { ...STT_DISABLED, ...common }
  if (rawMode === 'mock') return { ...STT_DISABLED, ...common, mode: 'mock' }
  if (rawMode !== 'soniox') throw new ConfigError('CLOUD_STT_MODE must be "soniox", "mock" or unset')
  const apiKey = env.CLOUD_SONIOX_API_KEY ?? ''
  if (apiKey === '' || /[\s]/.test(apiKey)) throw new ConfigError('CLOUD_SONIOX_API_KEY is required in soniox mode')
  const base = env.CLOUD_SONIOX_BASE_URL && env.CLOUD_SONIOX_BASE_URL !== '' ? env.CLOUD_SONIOX_BASE_URL : SONIOX_DEFAULT_BASE_URL
  let u: URL
  try {
    u = new URL(base)
  } catch {
    throw new ConfigError('CLOUD_SONIOX_BASE_URL must be an absolute http(s) URL')
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new ConfigError('CLOUD_SONIOX_BASE_URL must be http(s) without credentials/query')
  }
  const model = env.CLOUD_SONIOX_MODEL && env.CLOUD_SONIOX_MODEL !== '' ? env.CLOUD_SONIOX_MODEL : SONIOX_DEFAULT_MODEL
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(model)) throw new ConfigError('CLOUD_SONIOX_MODEL must be 1..32 chars [A-Za-z0-9._-]')
  return { ...common, mode: 'soniox', sonioxApiKey: apiKey, sonioxBaseUrl: base.replace(/\/+$/, ''), sonioxModel: model }
}

function loadPepper(env: Record<string, string | undefined>): string | null {
  const p = env.CLOUD_EMAIL_PEPPER ?? ''
  if (p === '') return null
  if (p.length < 32) throw new ConfigError('CLOUD_EMAIL_PEPPER must be at least 32 characters')
  return p
}

function loadMail(env: Record<string, string | undefined>): MailConfig {
  const rawMode = env.CLOUD_MAIL_MODE ?? ''
  if (rawMode === '') return MAIL_DISABLED
  if (rawMode !== 'smtp' && rawMode !== 'outbox') throw new ConfigError('CLOUD_MAIL_MODE must be "smtp", "outbox" or unset')
  const from = env.CLOUD_MAIL_FROM ?? ''
  if (!EMAIL_RE.test(from)) throw new ConfigError('CLOUD_MAIL_FROM must be a bare email address (e.g. letters@example.com)')
  if (rawMode === 'outbox') {
    const dir = env.CLOUD_MAIL_OUTBOX_DIR ?? ''
    if (dir === '') throw new ConfigError('CLOUD_MAIL_OUTBOX_DIR is required in outbox mode')
    return { ...MAIL_DISABLED, mode: 'outbox', from, outboxDir: dir }
  }
  const host = env.CLOUD_SMTP_HOST ?? ''
  if (host === '' || /[\s/]/.test(host)) throw new ConfigError('CLOUD_SMTP_HOST is required in smtp mode')
  const secure = env.CLOUD_SMTP_SECURE === '1' || env.CLOUD_SMTP_SECURE === 'true'
  const port = int(env, 'CLOUD_SMTP_PORT', secure ? 465 : 587, 1, 65535)
  const user = env.CLOUD_SMTP_USER ?? ''
  const pass = env.CLOUD_SMTP_PASS ?? ''
  if ((user === '') !== (pass === '')) throw new ConfigError('CLOUD_SMTP_USER and CLOUD_SMTP_PASS must be set together')
  return { mode: 'smtp', from, outboxDir: '', smtp: { host, port, secure, user, pass } }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): CloudConfig {
  const port = int(env, 'PORT', DEFAULT_PORT, 0, 65535)
  const mail = loadMail(env)
  const emailPepper = loadPepper(env)
  // Real mail = real addresses: the suppression-hash pepper must not live in the same DB it protects.
  if (mail.mode === 'smtp' && emailPepper === null) throw new ConfigError('CLOUD_EMAIL_PEPPER is required in smtp mode')
  return {
    port,
    host: env.CLOUD_HOST && env.CLOUD_HOST !== '' ? env.CLOUD_HOST : '127.0.0.1',
    dbPath: env.CLOUD_DB_PATH && env.CLOUD_DB_PATH !== '' ? env.CLOUD_DB_PATH : './data/cloud.db',
    publicOrigin: normalizeOrigin(env.CLOUD_PUBLIC_ORIGIN && env.CLOUD_PUBLIC_ORIGIN !== '' ? env.CLOUD_PUBLIC_ORIGIN : `http://localhost:${port || DEFAULT_PORT}`),
    tokenTtlS: int(env, 'CLOUD_TOKEN_TTL_S', 30 * 24 * 3600, 60, 365 * 24 * 3600),
    challengeTtlS: 300,
    bodyLimitBytes: int(env, 'CLOUD_BODY_LIMIT_BYTES', 64 * 1024, 1024, 16 * 1024 * 1024),
    rateWindowS: int(env, 'CLOUD_RATE_WINDOW_S', 60, 1, 3600),
    rateIpMax: int(env, 'CLOUD_RATE_IP_MAX', 120, 1, 1_000_000),
    rateAccountMax: int(env, 'CLOUD_RATE_ACCOUNT_MAX', 300, 1, 1_000_000),
    trustProxy: env.CLOUD_TRUST_PROXY === '1' || env.CLOUD_TRUST_PROXY === 'true',
    llm: loadLlm(env),
    chatDailyTokens: int(env, 'CLOUD_CHAT_DAILY_TOKENS', 200_000, 0, 1_000_000_000),
    mail,
    emailPepper,
    cardFetchMax: int(env, 'CLOUD_CARD_FETCH_MAX', 60, 1, 1_000_000),
    subscribeIpPerHour: int(env, 'CLOUD_SUBSCRIBE_IP_PER_HOUR', 10, 1, 1_000_000),
    subscribePublisherPerHour: int(env, 'CLOUD_SUBSCRIBE_PUBLISHER_PER_HOUR', 50, 1, 1_000_000),
    stt: loadStt(env),
    sttDailySeconds: int(env, 'CLOUD_STT_DAILY_SECONDS', 7200, 0, 86_400 * 10),
    audioDir: env.CLOUD_AUDIO_DIR && env.CLOUD_AUDIO_DIR !== '' ? env.CLOUD_AUDIO_DIR : './data/audio',
    meetingChunkRateMax: int(env, 'CLOUD_MEETING_CHUNK_RATE_MAX', 30, 1, 1_000_000)
  }
}
