import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CaptureSettingsStore, captureSettingsFile, nextLocalMidnight } from '../../src/main/capture/settings'

const roots: string[] = []
function storeRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-capture-settings-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const originalTz = process.env.TZ
beforeAll(() => {
  // A zone with a DST change inside the tested window (US DST ends 2026-11-01).
  process.env.TZ = 'America/Los_Angeles'
})
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

describe('nextLocalMidnight', () => {
  it('returns the next local 00:00, including across the DST change', () => {
    const t = Date.parse('2026-10-31T22:30:00-07:00') // PDT
    expect(new Date(nextLocalMidnight(t)).toISOString()).toBe('2026-11-01T07:00:00.000Z')
    const u = Date.parse('2026-11-01T12:00:00-08:00') // PST, 25-hour day just ended at 00:00
    expect(new Date(nextLocalMidnight(u)).toISOString()).toBe('2026-11-02T08:00:00.000Z')
    const atMidnight = Date.parse('2026-11-03T00:00:00-08:00')
    expect(nextLocalMidnight(atMidnight)).toBe(Date.parse('2026-11-04T00:00:00-08:00'))
  })
})

describe('CaptureSettingsStore', () => {
  it('persists exclusions and pause across a restart, 0600 and atomically', () => {
    const root = storeRoot()
    const file = captureSettingsFile(root)
    let now = Date.parse('2026-11-04T10:00:00-08:00')
    const a = new CaptureSettingsStore(file, () => now)
    a.addExclusion('bundleId', 'com.1password.1password')
    a.addExclusion('appName', 'Signal')
    a.addExclusion('bundleId', 'COM.1PASSWORD.1PASSWORD') // case-insensitive duplicate
    a.pauseNow()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])

    now += 3 * 3600_000
    const b = new CaptureSettingsStore(file, () => now) // "restart"
    expect(b.get().excluded).toEqual({ bundleIds: ['com.1password.1password'], appNames: ['Signal'] })
    expect(b.pauseState()).toMatchObject({ paused: true, mode: 'indefinite', until: null })
    expect(b.isExcluded('com.1Password.1password', '')).toBe(true)
    expect(b.isExcluded('', 'signal')).toBe(true)
    expect(b.isExcluded('com.apple.Notes', 'Notes')).toBe(false)
    b.removeExclusion('appName', 'SIGNAL')
    b.resume()
    const c = new CaptureSettingsStore(file, () => now)
    expect(c.get().excluded.appNames).toEqual([])
    expect(c.pauseState().paused).toBe(false)
  })

  it('pause until next local midnight ends at midnight, also after a restart', () => {
    const file = captureSettingsFile(storeRoot())
    let now = Date.parse('2026-11-04T23:10:00-08:00')
    const a = new CaptureSettingsStore(file, () => now)
    expect(a.pauseUntilNextMidnight()).toMatchObject({ paused: true, mode: 'until', until: '2026-11-05T08:00:00.000Z' })
    now = Date.parse('2026-11-04T23:59:59.999-08:00')
    expect(new CaptureSettingsStore(file, () => now).pauseState().paused).toBe(true)
    now = Date.parse('2026-11-05T00:00:00-08:00')
    const restarted = new CaptureSettingsStore(file, () => now)
    expect(restarted.pauseState().paused).toBe(false)
    expect(restarted.expireIfDue()).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pause).toEqual({ mode: 'none' })
  })

  it('moves an unreadable file aside and starts from defaults', () => {
    const root = storeRoot()
    const file = captureSettingsFile(root)
    fs.writeFileSync(file, '{"version":1,"excluded":"nope"}', { mode: 0o600 })
    const s = new CaptureSettingsStore(file)
    expect(s.loadError).toContain('invalid-')
    expect(s.get().excluded).toEqual({ bundleIds: [], appNames: [] })
    expect(fs.readdirSync(root).some((f) => f.includes('.invalid-'))).toBe(true)
  })

  it('rejects empty entries', () => {
    const s = new CaptureSettingsStore(captureSettingsFile(storeRoot()))
    expect(() => s.addExclusion('bundleId', '   ')).toThrow()
  })
})
