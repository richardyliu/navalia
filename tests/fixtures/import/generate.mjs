// Generates the synthetic import fixture home. All secrets below are FAKE test strings.
// Run: node tests/fixtures/import/generate.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = join(here, 'home')
const w = (rel, rows) => {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const base = (type, ts, extra) => ({
  parentUuid: null, isSidechain: false, userType: 'external', cwd: '/work/secret-app', sessionId: S1,
  version: '2.0.0', type, uuid: `${type}-${ts}`, timestamp: ts, ...extra
})
const FAKE_SK = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE0123456789abcdef'
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE'
const FAKE_AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const FAKE_GH = 'ghp_FAKE0123456789abcdefghijABCDEFGHIJ'
const FAKE_PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----'

w(`.claude/projects/-work-secret-app/${S1}.jsonl`, [
  { type: 'ai-title', sessionId: S1, aiTitle: 'Fix login flow' },
  base('user', '2025-10-01T09:00:00.000Z', { message: { role: 'user', content: `Please fix login. My key is ${FAKE_SK} and AWS ${FAKE_AWS}.` } }),
  base('user', '2025-10-01T09:00:01.000Z', { isMeta: true, message: { role: 'user', content: '<system-reminder>injected context</system-reminder>' } }),
  base('assistant', '2025-10-01T09:00:05.000Z', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE THOUGHT should not be imported' }, { type: 'text', text: 'Looking at the auth module.' }] } }),
  base('assistant', '2025-10-01T09:00:06.000Z', { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'env' } }] } }),
  base('user', '2025-10-01T09:00:07.000Z', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `PATH=/usr/bin\nHOME=/Users/alice\nOPENAI_API_KEY=${FAKE_SK}\nTOOL_RESULT_MARKER=1` }] } }),
  base('user', '2025-10-01T09:01:00.000Z', { message: { role: 'user', content: [{ type: 'text', text: `Here is my .env:\nDATABASE_PASSWORD=hunter2hunter2\nAPP_NAME=demo\naws_secret_access_key = ${FAKE_AWS_SECRET}` }] } }),
  base('assistant', '2025-10-01T09:01:10.000Z', { message: { role: 'assistant', content: [{ type: 'text', text: `Use the header:\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nand curl -H 'X-Api-Key: abc123secretvalue' https://example.test\nToken ${FAKE_GH}\n${FAKE_PEM}\nDone.` }] } }),
  base('user', '2025-10-01T09:02:00.000Z', { message: { role: 'user', content: 'Thanks, that works. Bearer abcdefghijklmnop1234 was the old one.' } })
])
// Subagent file for the same session → sidechain, must not be imported.
w(`.claude/projects/-work-secret-app/${S1}/subagents/agent-x.jsonl`, [
  { ...base('user', '2025-10-01T09:00:30.000Z', { message: { role: 'user', content: 'SIDECHAIN_MARKER subagent prompt' } }), isSidechain: true }
])

const S2 = 'bbbbbbbb-2222-4222-8222-222222222222'
w(`.codex/sessions/2025/10/02/rollout-2025-10-02T08-00-00-${S2}.jsonl`, [
  { timestamp: '2025-10-02T08:00:00.000Z', type: 'session_meta', payload: { id: S2, cwd: '/work/codex-proj' } },
  { timestamp: '2025-10-02T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  { timestamp: '2025-10-02T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a README section about setup.' }] } },
  { timestamp: '2025-10-02T08:00:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING_MARKER' }] } },
  { timestamp: '2025-10-02T08:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['cat', 'README.md'] }), call_id: 'c1' } },
  { timestamp: '2025-10-02T08:00:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'FUNCTION_OUTPUT_MARKER', metadata: { exit_code: 0 } }) } },
  { timestamp: '2025-10-02T08:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a Setup section.' }] } },
  { timestamp: '2025-10-02T08:00:07.000Z', type: 'event_msg', payload: { type: 'token_count' } }
])
console.log('fixture home written to', home)
