// C23 / X3 (DECISIONS-ROUND4 R4-1 approved X3): main injects the Runtime `[agent_funding]`
// transport, but it stays OFF by default and is gated by a readBudget()-based probe.
// - main/index.ts passes `transport: hetTransport` (createAgentFundingTransport) and a `budget`
//   probe that requires readBudget().enabled && !exhausted and the venv python;
// - het-settings.json assessorEnabled defaults to false → no call;
// - the E2E fixture env LENS_HET_FAKE_ASSESSOR is honoured only when !app.isPackaged (and a temp
//   Lens Store is set);
// - src/main/het has no network / LLM-SDK imports and no cloud imports (HET never uses cloud).
// Spawn-level coverage lives in agentFundingTransport.test.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FAKE_ASSESSOR_ENV } from '../../src/main/het/fixtureTransport'
import type { AssessorTransport } from '../../src/main/het/assessor'
import { createHetService, type HetBudgetState } from '../../src/main/het/service'
import { DEFAULT_HET_SETTINGS } from '../../src/main/het/settings'

const ROOT = path.join(__dirname, '..', '..')
const PREFIX = 'lens-c23-'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    if (path.basename(d).startsWith(PREFIX) && path.dirname(d) === fs.realpathSync(os.tmpdir())) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}het-`)))
  dirs.push(d)
  return d
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** The object literal passed to `createHetService({ … })` in main/index.ts. */
function hetServiceCall(src: string): string {
  const start = src.indexOf('createHetService({')
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced createHetService call')
}

describe('X3: HET assessor transport is injected but default off', () => {
  test('defaults: assessorEnabled false, sendSummariesToAssessor false', () => {
    expect(DEFAULT_HET_SETTINGS.assessorEnabled).toBe(false)
    expect(DEFAULT_HET_SETTINGS.sendSummariesToAssessor).toBe(false)
  })

  test('main/index.ts injects the agent_funding transport with a readBudget() probe; nothing turns the switch on', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
    const call = hetServiceCall(src)
    expect(call).toMatch(/\btransport:\s*hetTransport\b/)
    expect(src).toMatch(/const hetTransport = createAgentFundingTransport\(\{/)
    // budget probe: python present, Runtime agent_funding enabled and not exhausted
    expect(call).toMatch(/budget:\s*\(\)\s*=>/)
    expect(call).toMatch(/hetTransport\.available\(\)/)
    expect(call).toMatch(/readBudget\(\)/)
    expect(call).toMatch(/b\.enabled && !b\.exhausted \? \{ available: true \}/)
    // main never enables the assessor or the summaries switch on the user's behalf
    expect(src).not.toMatch(/setAssessorEnabled\(\s*true/)
    expect(src).not.toMatch(/setSendSummaries\(\s*true/)
    expect(src).not.toMatch(/assessorEnabled:\s*true/)
    // Fixture assessor only in unpackaged builds pointed at an explicit temp Lens Store.
    expect(call).toMatch(/allowFakeAssessor:\s*!app\.isPackaged\s*&&\s*Boolean\(process\.env\.LENS_STORE_ROOT/)
    // createHetService is only constructed in main/index.ts.
    const others = walk(path.join(ROOT, 'src/main'))
      .filter((f) => !f.endsWith(path.join('main', 'index.ts')) && !f.includes(`${path.sep}het${path.sep}`))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('createHetService('))
    expect(others).toEqual([])
  })

  test('with a transport injected: default off → no call; enabled but no budget probe / budget unavailable → no call', async () => {
    let calls = 0
    const transport: AssessorTransport = {
      name: 'agent_funding',
      async complete() {
        calls++
        return { outcome: 'ok', text: '{}' }
      }
    }
    const env = { LENS_HET_CLAUDE_ROOT: path.join(ROOT, 'tests/fixtures/het/claude'), LENS_HET_CODEX_ROOT: '' }
    const now = () => Date.UTC(2025, 8, 2)
    const cases: Array<{ enabled: boolean; budget?: () => HetBudgetState; state: string }> = [
      { enabled: false, budget: () => ({ available: true }), state: 'disabled' },
      { enabled: true, state: 'budget_unavailable' },
      { enabled: true, budget: () => ({ available: false, reason: 'exhausted' }), state: 'budget_unavailable' },
      { enabled: true, budget: () => ({ available: false, reason: 'not_enabled' }), state: 'budget_unavailable' }
    ]
    for (const c of cases) {
      const d = tmp()
      if (c.enabled) fs.writeFileSync(path.join(d, 'het-settings.json'), JSON.stringify({ version: 1, assessorEnabled: true }))
      const svc = createHetService({ dbFile: path.join(d, 'het.db'), settingsFile: path.join(d, 'het-settings.json'), transport, budget: c.budget, env, now })
      await svc.tickNow()
      expect(svc.status().assessor.state).toBe(c.state)
      expect(svc.summary(366).total_minutes_tenths).toBe(0)
      await svc.stop()
    }
    expect(calls).toBe(0)
  })

  test(`${FAKE_ASSESSOR_ENV} is ignored when the build does not allow it (packaged)`, async () => {
    const d = tmp()
    const fixture = path.join(d, 'fake.json')
    fs.writeFileSync(fixture, JSON.stringify({ default: 'quota' }))
    fs.mkdirSync(path.join(d, 'claude'))
    const logs: string[] = []
    const svc = createHetService({
      dbFile: path.join(d, 'het.db'),
      settingsFile: path.join(d, 'het-settings.json'),
      allowFakeAssessor: false, // what main passes when app.isPackaged
      env: { [FAKE_ASSESSOR_ENV]: fixture, LENS_HET_CLAUDE_ROOT: path.join(d, 'claude'), LENS_HET_CODEX_ROOT: '' },
      log: (m) => logs.push(m)
    })
    try {
      expect(svc.status()).toMatchObject({ transport: 'disabled', assessor: { enabled: false, transport_present: false, state: 'disabled' } })
      expect(logs.some((l) => l.includes(`${FAKE_ASSESSOR_ENV} ignored`))).toBe(true)
    } finally {
      await svc.stop()
    }
  })

  test('src/main/het has no network or LLM-SDK imports and is not wired to the cloud (HET never uses cloud)', () => {
    for (const f of walk(path.join(ROOT, 'src/main/het'))) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/\bfetch\s*\(|from 'node:(https?|net|tls)'|from '(https?|net|tls|undici)'|@anthropic-ai|from 'openai'/)
      expect(src, f).not.toMatch(/from '\.\.\/cloud\/|from '\.\.\/\.\.\/cloud|\/v1\/chat\/completions/)
    }
    for (const f of walk(path.join(ROOT, 'src/main/cloud'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/from '\.\.\/het\//)
    }
  })
})
