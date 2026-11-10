import { describe, expect, it } from 'vitest'
import { looksLikeEnvDump, redactForDisplay, stripSecrets } from '../../src/main/import/redact'
import { loadSession, scanTranscripts } from '../../src/main/import/transcripts'
import { renderSession } from '../../src/main/import/markdown'
import { CLAUDE_KEY, FIXTURE_HOME } from './helpers'

// All values below are fake, test-only strings.
const CASES: Array<[string, string, string]> = [
  ['Anthropic key', 'key sk-ant-api03-abcdefghijklmnop0123456789', 'sk-ant-api03-abcdefghijklmnop'],
  ['OpenAI short key', 'use sk-proj-abc123XYZ987 now', 'sk-proj-abc123XYZ987'],
  ['bearer token', 'curl with Bearer abcdefghijklmnop1234 here', 'abcdefghijklmnop1234'],
  ['Authorization header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ['x-api-key header', 'x-api-key: abc123secretvalue', 'abc123secretvalue'],
  ['cookie header', 'Cookie: session=abcdef123456', 'abcdef123456'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE is mine', 'AKIAIOSFODNN7EXAMPLE'],
  ['AWS temp key id', 'ASIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'],
  ['AWS secret', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['GitHub token', 'token ghp_FAKE0123456789abcdefghijABCDEFGHIJ', 'ghp_FAKE0123456789'],
  ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghij', 'github_pat_11ABCDEFG'],
  ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJzdWIiOiIxMjM0'],
  ['PEM block', 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter', 'MIIEowIBAAKCAQEA'],
  ['.env sensitive line', 'STRIPE_SECRET_KEY=whsec_notreal123', 'whsec_notreal123'],
  ['export line', 'export GITHUB_TOKEN=abc123notreal', 'abc123notreal'],
  ['password json', '{"password": "hunter2hunter2"}', 'hunter2hunter2'],
  ['url credentials', 'postgres://admin:s3cretpw@db.local/app', 's3cretpw'],
  ['curl -u', 'curl -u admin:pa55word https://x.test', 'pa55word'],
  ['email', 'mail me at alice@example.com', 'alice@example.com']
]

describe('import secret stripping', () => {
  for (const [name, input, secret] of CASES) {
    it(`strips ${name}`, () => {
      const r = stripSecrets(input)
      expect(r.text).not.toContain(secret)
      expect(r.redactions).toBeGreaterThan(0)
    })
  }

  it('keeps non-sensitive .env lines and ordinary prose', () => {
    const r = stripSecrets('APP_NAME=demo\nThe date is 2025-10-01.')
    expect(r.text).toContain('APP_NAME=demo')
    expect(r.text).toContain('2025-10-01')
  })

  it('drops whole env dumps', () => {
    const dump = 'PATH=/usr/bin\nHOME=/Users/alice\nSHELL=/bin/zsh'
    expect(looksLikeEnvDump(dump)).toBe(true)
    const r = stripSecrets(dump)
    expect(r.dropped).toBe(true)
    expect(r.text).not.toContain('/usr/bin')
    expect(looksLikeEnvDump('AA=1\nBB=2\nCC=3\nDD=4')).toBe(true)
    expect(looksLikeEnvDump('A=1\nnormal text')).toBe(false)
  })

  it('redactForDisplay redacts without dropping', () => {
    expect(redactForDisplay('PATH=/x\nHOME=/y\nerror sk-ant-abcdefghijkl123')).toContain('PATH=/x')
    expect(redactForDisplay('error sk-ant-abcdefghijkl123')).not.toContain('abcdefghijkl123')
  })

  it('fixture session Markdown contains none of the planted fake secrets', async () => {
    const files = (await scanTranscripts(FIXTURE_HOME)).sessions.find((x) => x.key === CLAUDE_KEY)!.files
    const s = (await loadSession(CLAUDE_KEY, files))!
    const md = renderSession(s, FIXTURE_HOME).documents.map((d) => d.content).join('\n')
    for (const secret of [
      'sk-ant-api03-FAKE',
      'AKIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI',
      'hunter2hunter2',
      'dXNlcjpwYXNzd29yZA',
      'abc123secretvalue',
      'ghp_FAKE',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
      'abcdefghijklmnop1234'
    ]) {
      expect(md, secret).not.toContain(secret)
    }
    expect(md).toContain('APP_NAME=demo')
    expect(md).toContain('Done.')
  })
})
