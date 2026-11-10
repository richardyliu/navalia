import { describe, expect, test } from 'vitest'
import { shortSummary } from '../../src/main/het/adapters/common'
import { redactText } from '../../src/main/het/redact'

/**
 * Security finding #3. All values are synthetic (well-known example/test strings or random
 * filler). Each row: input, the secret fragment that must NOT survive, optional fragment that must.
 */
const CASES: Array<[string, string, string, string?]> = [
  ['AWS secret (base64 with /)', 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['AWS secret bare', 'the key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY leaked', 'K7MDENG', 'leaked'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE is the id', 'AKIAIOSFODNN7EXAMPLE', 'is the id'],
  ['Google API key', 'use AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW for maps', 'AIzaSyA1b2C3d4', 'for maps'],
  ['Stripe secret', 'stripe ' + 'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc ok', 'sk_' + 'live_4eC39', 'ok'], // split so push protection doesn't flag Stripe's docs example key
  ['Stripe restricted test', 'rk_test_51H8abcdefGHIJKLmnop', 'rk_test_51H8'],
  ['OpenAI-style', 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234', 'sk-proj-abcdef'],
  ['GitHub token', 'ghp_1234567890abcdefghijABCDEFGHIJ', 'ghp_1234567890'],
  ['Slack token', 'xoxb-123456789012-abcdefghij', 'xoxb-1234'],
  ['JSON access_token', '{"access_token": "ya29.a0AfH6SMBexample", "x": 1}', 'ya29.a0AfH6SMBexample', '"x": 1'],
  ['JSON password', '{"password":"hunter2-correct-horse"}', 'hunter2-correct-horse'],
  ['single-quoted', "{'client_secret': 'cs_9f8e7d6c'}", 'cs_9f8e7d6c'],
  ['env style', 'DB_PASSWORD=s3cr3tValue! then', 's3cr3tValue', 'then'],
  ['URL credentials', 'clone https://alice:Tr0ub4dor@git.example.com/repo.git now', 'Tr0ub4dor', 'git.example.com'],
  ['postgres URL', 'postgres://admin:pa55w0rd@db.internal:5432/app', 'pa55w0rd'],
  ['32-hex', 'session 9f86d081884c7d659a2feaa0c55ad015 expired', '9f86d081884c7d659a2feaa0c55ad015', 'expired'],
  ['sha256 hex', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'e3b0c44298fc'],
  ['PEM body', 'here: -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA7bq9 more lines -----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'here:'],
  ['PEM openssh', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXkt'],
  ['natural language password', 'my password is hunter2 please', 'hunter2', 'please'],
  ['natural language token', 'the token was abc123xyz', 'abc123xyz'],
  ['bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc', 'eyJhbGciOiJIUzI1NiJ9'],
  ['email', 'mail jane.doe@example.com about it', 'jane.doe@example.com', 'about it'],
  ['phone', 'call +1 (415) 555-0134 tomorrow', '555-0134', 'tomorrow'],
  ['home path user', 'edit /Users/janedoe/Documents/app/src/main.ts', 'janedoe', '/Documents/app/src/main.ts'],
  ['linux home user', 'cat /home/bob/.ssh/config', '/home/bob/', '.ssh/config']
]

describe('HET redaction (finding #3)', () => {
  test.each(CASES)('%s', (_name, input, mustNotSurvive, mustSurvive) => {
    for (const out of [redactText(input), shortSummary(input)]) {
      expect(out).not.toContain(mustNotSurvive)
      if (mustSurvive) expect(out).toContain(mustSurvive)
    }
  })

  test('no over-redaction of ordinary task text', () => {
    const keep = [
      'Add a --dry-run flag to the export command',
      'see src/main/het/adapters/claudeCode.ts line 120',
      '/work/demo-app/src/some-long-directory-name/another/file.ts',
      'test_should_render_component_correctly_when_list_is_empty',
      'npm run typecheck && npm test',
      'version 2.0.0 released on 2025-09-01'
    ]
    for (const k of keep) expect(redactText(k)).toBe(k)
  })

  test('summary stays ≤ 200 chars and bounded on huge input', () => {
    const big = 'x '.repeat(500_000) + 'sk-abcdefghijklmnopqrstuv'
    const out = shortSummary(big)
    expect(out.length).toBeLessThanOrEqual(200)
  })
})
