import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ONBOARDING_CHANNELS } from '../../src/main/onboarding/api'
import { registerOnboardingIpc } from '../../src/main/onboarding/ipc'
import {
  finishOnboarding,
  onboardingFile,
  onboardingStatus,
  priorDataSignals,
  resetOnboarding
} from '../../src/main/onboarding/store'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function store(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-onb-'))
  tmp.push(d)
  // Mirror what the app creates at boot (ensureStore + audit.db): these must NOT count as user data.
  fs.mkdirSync(path.join(d, 'identity'), { mode: 0o700 })
  fs.mkdirSync(path.join(d, 'cards'), { mode: 0o700 })
  fs.writeFileSync(path.join(d, 'audit.db'), '')
  fs.writeFileSync(path.join(d, 'het-settings.json'), '{}')
  return d
}

const fixed = () => new Date('2026-11-05T08:00:00.000Z')

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777
}

describe('first-run detection', () => {
  it('fresh store ⇒ show, reason first_run, nothing written', () => {
    const root = store()
    expect(priorDataSignals(root)).toEqual([])
    expect(onboardingStatus(root, fixed)).toEqual({
      show: true,
      reason: 'first_run',
      completedAt: null,
      skippedAt: null,
      lastStep: null
    })
    expect(fs.existsSync(onboardingFile(root))).toBe(false)
  })

  it('missing store root ⇒ first run, no crash', () => {
    const root = path.join(store(), 'does-not-exist')
    expect(onboardingStatus(root, fixed).show).toBe(true)
  })

  it.each([
    ['identity/identity.json', (r: string) => fs.writeFileSync(path.join(r, 'identity', 'identity.json'), '{}')],
    ['settings.json', (r: string) => fs.writeFileSync(path.join(r, 'settings.json'), '{}')],
    ['grants.json', (r: string) => fs.writeFileSync(path.join(r, 'grants.json'), '{}')],
    ['capture-settings.json', (r: string) => fs.writeFileSync(path.join(r, 'capture-settings.json'), '{}')],
    ['cards/', (r: string) => fs.writeFileSync(path.join(r, 'cards', 'card-1.json'), '{}')],
    ['workflows/', (r: string) => {
      fs.mkdirSync(path.join(r, 'workflows'))
      fs.writeFileSync(path.join(r, 'workflows', 'w.json'), '{}')
    }],
    ['peers/', (r: string) => {
      fs.mkdirSync(path.join(r, 'peers'))
      fs.writeFileSync(path.join(r, 'peers', 'p.json'), '{}')
    }]
  ])('legacy store with %s ⇒ not shown, legacy record written 0600', (signal, seed) => {
    const root = store()
    seed(root)
    expect(priorDataSignals(root)).toEqual([signal])
    const s = onboardingStatus(root, fixed)
    expect(s).toMatchObject({ show: false, reason: 'legacy' })
    expect(mode(onboardingFile(root))).toBe(0o600)
    // Stable even after the data goes away.
    fs.rmSync(path.join(root, signal.replace(/\/$/, '')), { recursive: true, force: true })
    expect(onboardingStatus(root, fixed)).toMatchObject({ show: false, reason: 'legacy' })
  })

  it('empty workflows/ or dot-files only do not count', () => {
    const root = store()
    fs.mkdirSync(path.join(root, 'workflows'))
    fs.writeFileSync(path.join(root, 'cards', '.DS_Store'), '')
    expect(priorDataSignals(root)).toEqual([])
    expect(onboardingStatus(root, fixed).show).toBe(true)
  })

  it.each([
    ['not json', '{oops'],
    ['wrong shape', JSON.stringify({ version: 2, outcome: 'completed' })],
    ['unknown outcome', JSON.stringify({ version: 1, outcome: 'maybe', lastStep: null, completedAt: null, skippedAt: null, updatedAt: 'x' })],
    ['empty', '']
  ])('corrupt record (%s) ⇒ safe default: not shown, no crash, file left alone', (_n, body) => {
    const root = store()
    fs.writeFileSync(onboardingFile(root), body)
    expect(onboardingStatus(root, fixed)).toEqual({
      show: false,
      reason: 'corrupt',
      completedAt: null,
      skippedAt: null,
      lastStep: null
    })
    expect(fs.readFileSync(onboardingFile(root), 'utf8')).toBe(body)
  })

  it('a directory in place of the record ⇒ corrupt, no crash', () => {
    const root = store()
    fs.mkdirSync(onboardingFile(root))
    expect(onboardingStatus(root, fixed).reason).toBe('corrupt')
  })
})

describe('finish / reset', () => {
  it('completed ⇒ never shows again; record 0600 with only safe fields', () => {
    const root = store()
    const s = finishOnboarding(root, { outcome: 'completed', lastStep: 'done' }, fixed)
    expect(s).toEqual({ show: false, reason: 'completed', completedAt: '2026-11-05T08:00:00.000Z', skippedAt: null, lastStep: 'done' })
    expect(onboardingStatus(root, fixed)).toEqual(s)
    const file = onboardingFile(root)
    expect(mode(file)).toBe(0o600)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(Object.keys(rec).sort()).toEqual(['completedAt', 'lastStep', 'outcome', 'skippedAt', 'updatedAt', 'version'])
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toMatch(/token|secret|key|bearer|password|\/Users\/|\/home\/|[A-Za-z]:\\/i)
    expect(text).not.toContain(root)
  })

  it('skipped ⇒ never shows again, skippedAt set', () => {
    const root = store()
    finishOnboarding(root, { outcome: 'skipped', lastStep: 'permissions' }, fixed)
    expect(onboardingStatus(root, fixed)).toEqual({
      show: false,
      reason: 'skipped',
      completedAt: null,
      skippedAt: '2026-11-05T08:00:00.000Z',
      lastStep: 'permissions'
    })
  })

  it('reset ⇒ shows again (reason reopened), keeps old timestamps; finishing again hides it', () => {
    const root = store()
    finishOnboarding(root, { outcome: 'completed', lastStep: 'done' }, fixed)
    const r = resetOnboarding(root, fixed)
    expect(r).toMatchObject({ show: true, reason: 'reopened', completedAt: '2026-11-05T08:00:00.000Z' })
    expect(onboardingStatus(root, fixed).show).toBe(true)
    finishOnboarding(root, { outcome: 'skipped', lastStep: 'welcome' }, fixed)
    expect(onboardingStatus(root, fixed)).toMatchObject({ show: false, reason: 'skipped' })
  })

  it('reset over a corrupt record recovers', () => {
    const root = store()
    fs.writeFileSync(onboardingFile(root), 'garbage')
    expect(resetOnboarding(root, fixed).show).toBe(true)
    expect(mode(onboardingFile(root))).toBe(0o600)
  })
})

describe('onboarding IPC', () => {
  function setup(storeRoot: string) {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<any>>()
    registerOnboardingIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, { storeRoot })
    return { handlers, invoke: (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw) }
  }

  it('registers exactly the lens:onboarding:* channels', () => {
    const { handlers } = setup(store())
    expect([...handlers.keys()].sort()).toEqual(Object.values(ONBOARDING_CHANNELS).sort())
    for (const ch of handlers.keys()) expect(ch.startsWith('lens:onboarding:')).toBe(true)
  })

  it('status → finish → status round trip', async () => {
    const root = store()
    const { invoke } = setup(root)
    expect(await invoke(ONBOARDING_CHANNELS.status)).toMatchObject({ ok: true, data: { show: true, reason: 'first_run' } })
    const f = await invoke(ONBOARDING_CHANNELS.finish, { outcome: 'completed', lastStep: 'done' })
    expect(f).toMatchObject({ ok: true, data: { show: false, reason: 'completed' } })
    expect(await invoke(ONBOARDING_CHANNELS.status)).toMatchObject({ ok: true, data: { show: false } })
    expect(await invoke(ONBOARDING_CHANNELS.reset)).toMatchObject({ ok: true, data: { show: true, reason: 'reopened' } })
  })

  it.each([
    [{ outcome: 'completed' }],
    [{ outcome: 'done', lastStep: 'done' }],
    [{ outcome: 'skipped', lastStep: 'nope' }],
    [{ outcome: 'skipped', lastStep: 'welcome', extra: 1 }],
    ['completed'],
    [undefined]
  ])('finish rejects bad payload %j without writing', async (raw) => {
    const root = store()
    const { invoke } = setup(root)
    const r = await invoke(ONBOARDING_CHANNELS.finish, raw)
    expect(r.ok).toBe(false)
    expect(r.error.message).toMatch(/Invalid arguments/)
    expect(fs.existsSync(onboardingFile(root))).toBe(false)
  })

  it('status rejects arguments', async () => {
    const { invoke } = setup(store())
    expect((await invoke(ONBOARDING_CHANNELS.status, { x: 1 })).ok).toBe(false)
  })

  it('write failure returns a sanitised error (no path)', async () => {
    const root = store()
    const blocker = path.join(root, 'blocked')
    fs.writeFileSync(blocker, '') // a FILE where the store dir should be ⇒ mkdir fails
    const { invoke } = setup(path.join(blocker, 'store'))
    const r = await invoke(ONBOARDING_CHANNELS.finish, { outcome: 'skipped', lastStep: 'welcome' })
    expect(r.ok).toBe(false)
    expect(r.error.message).not.toContain(root)
    expect(r.error.message).toMatch(/onboarding record/)
  })
})
