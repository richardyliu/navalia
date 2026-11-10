/**
 * HET summary/title redactor (security finding #3). Pure; errs on over-redaction.
 *
 * Applied to every AgentEvent summary and session title before it is kept in memory,
 * persisted in het.db, or (opt-in only, see `sendSummariesToAssessor`) sent to an assessor.
 * Email / home-path / phone rules are copied from identity/redact.ts (no cross-plane import).
 * Order matters: structural rules (PEM, URL creds, key=value) run before generic runs.
 */

type Rule = [RegExp, string | ((m: string, ...g: string[]) => string)]

const KEY_NAMES =
  'access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|private[_-]?key|authorization|cookie|session[_-]?id'

const RULES: Rule[] = [
  // PEM private keys: drop everything after the header.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, '[redacted-private-key]'],
  // scheme://user:pass@host → scheme://[redacted]@host
  // (S1-R3-SEC L1: bounded scheme / user / password; the unbounded scheme was quadratic on "a.a.a.…")
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,512}@/gi, '$1[redacted]@'],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  // S1-R3-SEC M1: curl -H / --header '<Name>: <value>' for ANY header name (quoted or not).
  [/(^|\s)(-H|--header)(\s+|=)(["'])([^"'\n:]{1,128}):[^"'\n]{0,8192}\4/g, '$1$2$3$4$5: [redacted]$4'],
  [/(^|\s)(-H|--header)(\s+|=)([A-Za-z0-9_-]{1,128}):(?!\s*\[redacted\])\s*[^\s"']+/g, '$1$2$3$4: [redacted]'],
  // Authorization: <scheme> <credential> anywhere in a line: drop both scheme and credential.
  [/\b(Proxy-)?Authorization\s*:\s*(?:[A-Za-z][\w-]{0,31}\s+)?[^\s"']+/gi, (_m: string, p?: string) => `${p ?? ''}Authorization: [redacted]`],
  // mysql family `-p<password>` (no space; `-p` alone prompts) and docker/podman/helm login `-p <password>`.
  [/(\b(?:mysql\w*|mariadb\w*)\b[^\n|;&]{0,512}?\s-p)(?=[^\s-])[^\s"']+/g, '$1[redacted]'],
  [/(\b(?:docker|podman|buildah|nerdctl|helm(?:\s+registry)?)\s+login\b[^\n|;&]{0,512}?\s-p)(\s+|=)?[^\s"']+/g, '$1$2[redacted]'],
  // --password=x / --password x (not --password-stdin)
  [/(--(?:password|passwd|pass))(=|\s+)(?!\[redacted\])(?!-)[^\s"']+/gi, '$1$2[redacted]'],
  // NAME=value mid-line (no lookbehind): PGPASSWORD=…, DB_PASS=…, GH_AUTH=… (upper-case env style, any prefix)
  [/\b([A-Z0-9_]{0,64}(?:PASS|PASSWD|PASSWORD|PWD|TOKEN|SECRET|KEY|AUTH)[A-Z0-9_]{0,64})=(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1=[redacted]'],
  // …and lower/mixed case only when the keyword is a whole `_`/`-` segment (db_pass=, api-key=; not monkey=, author=)
  [
    /\b((?:[A-Za-z0-9]{1,32}[_-]){0,6}(?:pass|passwd|password|pwd|token|secret|key|auth)(?:[_-][A-Za-z0-9]{1,32}){0,6})=(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    '$1=[redacted]'
  ],
  // key=value / key: value / "key": "value" (quotes optional; DB_PASSWORD-style prefixes allowed)
  [
    new RegExp(`(["']?)(?<![A-Za-z0-9])(${KEY_NAMES})\\1\\s*[:=]\\s*("[^"]*"|'[^']*'|\\S+)`, 'gi'),
    (m: string, q: string, k: string, v: string) => (/^Bearer$/i.test(v) ? m : `${q}${k}${q}: [redacted]`)
  ],
  // natural language: "password is hunter2", "my token was abc"
  [/\b(password|passwd|passcode|passphrase|pin|secret|token|api key)\s+(is|was|=)\s+\S+/gi, '$1 $2 [redacted]'],
  // vendor token shapes
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b[sr]k_(?:live|test)_[0-9A-Za-z]{10,}/g, '[redacted]'],
  [/\bpk_(?:live|test)_[0-9A-Za-z]{10,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted]'],
  // identity/redact.ts rules (email, home paths → keep the tail, drop the user name)
  // S1-R3-SEC L1: bounded local part / domain (the unbounded form is quadratic on "a.a.a.…").
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g, '[email]'],
  [/\/(Users|home)\/[^/\s"'<>]+/g, '/$1/[user]'],
  // long hex (hashes, API keys)
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted]'],
  // generic base64/base64url run ≥ 32 incl. '/', when it looks random (digit + letter, ≤ 2 slashes)
  [
    /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    (m: string) => {
      const slashes = (m.match(/\//g) ?? []).length
      return /\d/.test(m) && /[A-Za-z]/.test(m) && slashes <= 2 ? '[redacted]' : m
    }
  ],
  // phone numbers. Narrower than identity/redact.ts on purpose: that rule also eats ISO dates
  // ("2025-09-01"), which are common in task text. International (+…) or 3-3-4 shapes only.
  [/(?<![\w+])(?:\+\d[\d\s().-]{7,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g, '[phone]']
]

export function redactText(text: string): string {
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, rep as never)
  return out
}
