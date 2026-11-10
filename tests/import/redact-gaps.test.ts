import { describe, expect, it } from 'vitest'
import { stripSecrets } from '../../src/main/import/redact'
import { redactText } from '../../src/main/het/redact'
import { renderSession, TOOL_COMMAND_MAX } from '../../src/main/import/markdown'
import { loadSession, scanTranscripts } from '../../src/main/import/transcripts'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME } from './helpers'

// S1-R3-SEC M1: probes from the security review that leaked through stripSecrets / redactText.
// All values are fake, test-only strings. Row: name, input, fragment that must NOT survive, fragment that must.
const PROBES: Array<[string, string, string, string?]> = [
  ['mid-line PGPASSWORD', 'cd app && PGPASSWORD=hunter2secret psql -h db', 'hunter2secret', 'psql'],
  ['export DB_PASS', 'export DB_PASS=hunter2secret', 'hunter2secret', 'DB_PASS'],
  ['mid-line DB_PASS', 'run it with DB_PASS=hunter2secret ./start.sh', 'hunter2secret', './start.sh'],
  ['MYSQL_PWD', 'MYSQL_PWD=hunter2secret mysql -u root', 'hunter2secret'],
  ['lowercase db_pass', 'set db_pass=hunter2secret here', 'hunter2secret', 'here'],
  ['GH_AUTH mid-line', 'echo ok; GH_AUTH=hunter2secret gh pr list', 'hunter2secret', 'gh pr list'],
  ['mysql -p', 'mysql -u root -phunter2secret mydb', 'hunter2secret', 'mydb'],
  ['mysqldump -p', 'mysqldump -uroot -phunter2secret app > dump.sql', 'hunter2secret', 'dump.sql'],
  ['docker login -p', 'docker login -u bob -p hunter2secret registry.example.test', 'hunter2secret', 'registry.example.test'],
  ['curl custom auth header', 'curl -H "X-Custom-Auth: hunter2secret" https://api.example.test', 'hunter2secret', 'X-Custom-Auth'],
  ['curl --header custom', "curl --header 'X-Session: hunter2secret' https://api.example.test", 'hunter2secret', 'X-Session'],
  ['curl -H unquoted', 'curl -H X-Api:hunter2secret https://api.example.test', 'hunter2secret'],
  ['--header Authorization Basic', "curl --header 'Authorization: Basic dXNlcjpwYXNz' https://x.test", 'dXNlcjpwYXNz'],
  ['mid-line Authorization Basic', 'then send Authorization: Basic dXNlcjpwYXNz to it', 'dXNlcjpwYXNz', 'to it'],
  ['Authorization custom scheme', 'header Authorization: Token hunter2secret ok', 'hunter2secret', 'ok'],
  ['--password=x', 'psql --password=hunter2secret --host db', 'hunter2secret', '--host db'],
  ['--password x', 'tool login --password hunter2secret --user bob', 'hunter2secret', '--user bob']
]

describe('M1 redaction gaps: stripSecrets (import) and redactText (HET)', () => {
  for (const [name, input, secret, keep] of PROBES) {
    it(`stripSecrets: ${name}`, () => {
      const r = stripSecrets(input)
      expect(r.text).not.toContain(secret)
      expect(r.redactions).toBeGreaterThan(0)
      if (keep) expect(r.text).toContain(keep)
    })
    it(`redactText: ${name}`, () => {
      const out = redactText(input)
      expect(out).not.toContain(secret)
      if (keep) expect(out).toContain(keep)
    })
  }

  it('Authorization: both the scheme and the credential are redacted', () => {
    const out = stripSecrets("curl --header 'Authorization: Basic dXNlcjpwYXNz'").text
    expect(out).not.toContain('Basic')
    expect(out).toContain('Authorization: [redacted]')
  })

  it('does not over-redact ordinary commands and prose', () => {
    const keep = [
      'mysql -u root -p mydb',
      'docker run -p 8080:80 nginx',
      'git log -p src/main.ts',
      'export PATH=/usr/local/bin:/usr/bin',
      'NODE_ENV=production npm run build',
      'const monkey=1; const keyboard=2',
      'the author=bob field and passive=true',
      'docker login --password-stdin registry.example.test',
      'sort -h sizes.txt',
      'Add a --dry-run flag to the export command',
      'version 2.0.0 released on 2025-09-01'
    ]
    for (const k of keep) {
      expect(redactText(k), k).toBe(k)
      expect(stripSecrets(k).text, k).toBe(k)
    }
  })

  it('normal fixture transcripts keep their prose and commands', async () => {
    const r = await scanTranscripts(FIXTURE_HOME)
    const docs = []
    for (const key of [CLAUDE_KEY, CODEX_KEY]) {
      const s = (await loadSession(key, r.sessions.find((x) => x.key === key)!.files))!
      docs.push(...renderSession(s, FIXTURE_HOME, { includeTools: true }).documents.map((d) => d.content))
    }
    const md = docs.join('\n')
    expect(md).toContain('APP_NAME=demo')
    expect(md).toContain('Done.')
    expect(md).toContain('命令：`cat README.md`')
  })
})

describe('M1 markdown: the whole first command line is redacted before truncation', () => {
  it('a token straddling the 300-char cut is not partially kept', () => {
    const token = 'ghp_' + 'Q'.repeat(16) + 'abcdefghij0123456789'
    // Put the token so that only `ghp_` + 16 chars (< the 20 the vendor rule needs) fall inside the cut.
    const pad = 'echo ' + 'x'.repeat(TOOL_COMMAND_MAX - 5 - 1 - 20) + ' '
    const command = pad + token + ' && echo done'
    expect(pad.length + 20).toBe(TOOL_COMMAND_MAX)
    const session = {
      key: 'claude-code:x',
      source: 'claude-code' as const,
      sessionId: 'x',
      project: null,
      title: null,
      files: [],
      startTs: 1,
      endTs: 2,
      messages: [{ role: 'assistant' as const, ts: 1, text: '', tools: ['Bash'], toolCalls: [{ name: 'Bash', command, paths: [] }] }]
    }
    const md = renderSession(session, '/Users/alice', { includeTools: true }).documents[0].content
    expect(md).not.toContain('Q'.repeat(16))
    expect(md).toContain('[redacted]')
  })
})
