import { redactText } from '../het/redact'

/**
 * Secret stripping for imported transcripts. Import-specific structural rules run first
 * (they understand multi-line shapes such as PEM blocks, env dumps and HTTP headers), then
 * the HET redactor (`het/redact.ts`: bearer, key=value, sk-/ghp_/AKIA/AIza…, emails, home
 * paths, long hex/base64). Errs on over-redaction.
 */

export const REDACTED = '[redacted]'
const ENV_DUMP_PLACEHOLDER = '[已省略：疑似环境变量 / 凭据输出]'

const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=\s*(.*)$/
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSW|PWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE|DSN|DATABASE_URL|CONN)/i

type Rule = [RegExp, string | ((m: string, ...g: string[]) => string)]

const RULES: Rule[] = [
  // Complete PEM / OpenSSH private key blocks (het's rule handles an unterminated header).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
  // HTTP auth headers (any scheme), API-key headers, cookies.
  [/^(\s*[-\w]*(?:authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*:\s*).+$/gim, `$1${REDACTED}`],
  // curl -H 'Authorization: …' / -u user:pass
  [/(-H\s*["'][^"':]*(?:authorization|api-key|token|cookie)[^"':]*:\s*)[^"']+/gi, `$1${REDACTED}`],
  [/(\s-u\s+)([^\s:]+):(\S+)/g, `$1$2:${REDACTED}`],
  // AWS secret access key assignments and temporary key ids.
  [/(aws_secret_access_key|aws_session_token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{16,}/gi, `$1$2${REDACTED}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Anthropic / OpenAI style keys incl. short-ish ones the het rule (≥16) might miss.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}/g, REDACTED],
  // Slack / GitHub fine-grained tokens.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED]
]

export interface StripResult {
  text: string
  /** Number of replacement markers introduced. */
  redactions: number
  /** True when the whole text was dropped as an env/credential dump. */
  dropped: boolean
}

/** Heuristic: ≥ 4 `NAME=value` lines, or a typical `env` dump (PATH= + HOME=/USER=). */
export function looksLikeEnvDump(text: string): boolean {
  const lines = text.split('\n')
  let envLines = 0
  let path = false
  let home = false
  for (const l of lines) {
    const m = ENV_LINE.exec(l)
    if (!m) continue
    envLines++
    if (m[1] === 'PATH') path = true
    if (m[1] === 'HOME' || m[1] === 'USER') home = true
  }
  return envLines >= 4 || (path && home)
}

/** `.env`-looking lines: keep the name, drop the value when the name looks sensitive. */
function stripEnvLines(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = ENV_LINE.exec(l)
      if (!m || !m[2].trim()) return l
      return SENSITIVE_NAME.test(m[1]) ? l.replace(/=.*/, `=${REDACTED}`) : l
    })
    .join('\n')
}

const MARKER = /\[(?:redacted[^\]]*|email|phone)\]|\/(?:Users|home)\/\[user\]/g
const countMarkers = (s: string): number => (s.match(MARKER) ?? []).length

function applyRules(input: string): string {
  let out = stripEnvLines(input)
  for (const [re, rep] of RULES) out = out.replace(re, rep as never)
  return redactText(out)
}

export function stripSecrets(input: string): StripResult {
  if (looksLikeEnvDump(input)) return { text: ENV_DUMP_PLACEHOLDER, redactions: 1, dropped: true }
  const before = countMarkers(input)
  const out = applyRules(input)
  return { text: out, redactions: Math.max(0, countMarkers(out) - before), dropped: false }
}

/** Redact CLI output / errors before they reach the renderer (no env-dump dropping). */
export function redactForDisplay(s: string): string {
  return applyRules(s)
}
