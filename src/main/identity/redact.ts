/**
 * Conservative text scrubber for Card content.
 *
 * `/model/graph` is the owner's unredacted view (runtime builds it with redact=False),
 * so anything copied into a shareable Card passes through here first. This is a Lens
 * scrubber, not the runtime's egress scanner; it errs on over-redaction.
 */
const RULES: Array<[RegExp, string]> = [
  // Key/value secrets first, so the key stays readable and only the value is replaced.
  [/("[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|apikey|auth|credential)[A-Za-z0-9_-]*"\s*:\s*")[^"]*(")/gi, '$1[secret]$2'],
  [/\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g, '$1=[secret]'],
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/g, '$1 [secret]'],
  [/(password|passwd|passcode|pwd|密码|口令)(\s*(?:is|was|:|：|=|为|是)\s*)\S+/gi, '$1$2[secret]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[secret]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g, '[secret]'],
  [/\b(?:whsec_|github_pat_|ghs_|glpat-)[0-9A-Za-z_-]{16,}\b/g, '[secret]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[secret]'],
  // AWS secret access keys and other 40+ char base64 blobs (with / or +).
  [/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40,}={0,2}(?![A-Za-z0-9/+=])/g, '[secret]'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[secret]'],
  // S1-R3-SEC L1: bounded (the unbounded form is quadratic on "a.a.a.…").
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g, '[email]'],
  [/\b(?:https?|ftp|file):\/\/[^\s<>"'）)]+/gi, '[url]'],
  [/(?:~|\/Users|\/home|\/private|\/var|\/tmp|\/Volumes)\/[^\s"'<>，。]*/g, '[path]'],
  [/\b(?:sk|pk|ghp|gho|xox[abpr]|AKIA)[-_A-Za-z0-9]{12,}\b/g, '[secret]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[secret]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[secret]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  // Phone numbers: international +… or the 3-3-4 shape only (copied from het/redact.ts) so ISO dates survive.
  [/(?<![\w+])(?:\+\d[\d\s().-]{7,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g, '[phone]']
]

export type Redactor = (text: string) => string

export const scrubText: Redactor = (text) => {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
