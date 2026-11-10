// C19 per-connector consent: required per kind, granted only after the main native confirm,
// re-checked at commit time, revocable; consent.json is 0600 and documents what was agreed.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONSENT_KINDS, CONSENT_TEXT, CONSENT_TEXT_VERSION } from '../../src/main/connectors/api'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { createConnectorService } from '../../src/main/connectors/service'
import { rmTmp, tmpDir } from './tmp-helper'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')

function setup() {
  const storeRoot = tmpDir('consent')
  const remembered: unknown[] = []
  const svc = createConnectorService({
    storeRoot,
    runtimeRoot: () => storeRoot,
    persomeBin: () => null,
    ossTool: async (_n, a) => {
      remembered.push(a)
      return JSON.stringify({ entry_id: `e-${remembered.length}` })
    },
    postRuntime: async (_r, b) => ({ data: { received: (b as { events: unknown[] }).events.length } })
  })
  return { svc, storeRoot, remembered }
}

describe('connector consent', () => {
  it('nothing is granted by default; each kind needs its own grant', async () => {
    const { svc, storeRoot } = setup()
    expect(svc.consent.list().map((c) => [c.kind, c.granted])).toEqual(CONSENT_KINDS.map((k) => [k, false]))
    await expect(svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))).rejects.toMatchObject({ code: 'unauthorized' })
    svc.consent.grant('health')
    await expect(svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))).rejects.toThrow(/日历（.ics 文件）/)
    await expect(svc.previewFile('email', path.join(__dirname, 'fixtures', 'multipart.eml'))).rejects.toThrow(/同意/)
    await expect(svc.previewFile('csv', path.join(FIX, 'health.csv'))).rejects.toThrow(/同意/)
    expect((await svc.previewFile('health', path.join(FIX, 'health.csv'))).items.length).toBeGreaterThan(0)
    svc.consent.grant('calendar')
    expect((await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))).items).toHaveLength(3)
    rmTmp(storeRoot)
  })

  it('consent.json: 0600, records what is read / written and when; revoke keeps the history', () => {
    const { svc, storeRoot } = setup()
    const g = svc.consent.grant('imap')
    expect(g).toMatchObject({ kind: 'imap', granted: true, revokedAt: null })
    expect(fs.statSync(svc.paths.consentPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(svc.paths.consentPath)).mode & 0o777).toBe(0o700)
    const onDisk = JSON.parse(fs.readFileSync(svc.paths.consentPath, 'utf8'))
    expect(onDisk.records.imap).toMatchObject({ granted: true, text_version: CONSENT_TEXT_VERSION, reads: CONSENT_TEXT.imap.reads, writes: CONSENT_TEXT.imap.writes })
    expect(typeof onDisk.records.imap.granted_at).toBe('string')
    const r = svc.consent.revoke('imap')
    expect(r).toMatchObject({ granted: false, grantedAt: null })
    expect(r.revokedAt).not.toBeNull()
    expect(JSON.parse(fs.readFileSync(svc.paths.consentPath, 'utf8')).records.imap.granted_at).toBe(onDisk.records.imap.granted_at)
    rmTmp(storeRoot)
  })

  it('revoking between preview and commit blocks the write; held previews of that kind are dropped', async () => {
    const { svc, storeRoot, remembered } = setup()
    svc.consent.grant('calendar')
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    svc.consent.revoke('calendar')
    await expect(svc.commit(p.previewId!, p.items.map((i) => i.key), {})).rejects.toThrow(/过期|同意/)
    expect(remembered).toHaveLength(0)
    // Even if a preview survived (granted again, then a stale id), the write path re-checks consent.
    svc.consent.grant('calendar')
    const p2 = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    fs.writeFileSync(svc.paths.consentPath, JSON.stringify({ version: 1, records: {} }))
    await expect(svc.commit(p2.previewId!, p2.items.map((i) => i.key), {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(remembered).toHaveLength(0)
    rmTmp(storeRoot)
  })

  it('a grant for an older text version, a corrupt file or a prototype key does not count', () => {
    const { svc, storeRoot } = setup()
    svc.consent.grant('csv')
    const f = JSON.parse(fs.readFileSync(svc.paths.consentPath, 'utf8'))
    f.records.csv.text_version = CONSENT_TEXT_VERSION - 1
    fs.writeFileSync(svc.paths.consentPath, JSON.stringify(f))
    expect(svc.consent.get('csv').granted).toBe(false)
    fs.writeFileSync(svc.paths.consentPath, '{not json')
    expect(svc.consent.list().every((c) => !c.granted)).toBe(true)
    fs.writeFileSync(svc.paths.consentPath, `{"version":1,"records":{"__proto__":{"calendar":{"granted":true,"granted_at":"x","text_version":${CONSENT_TEXT_VERSION}}}}}`)
    expect(svc.consent.get('calendar').granted).toBe(false)
    rmTmp(storeRoot)
  })

  it('IPC: no consent → no file dialog; grant needs the main native confirm (absent / cancelled → refused)', async () => {
    const { svc, storeRoot } = setup()
    let dialogs = 0
    const reg = (confirm?: (k: string) => Promise<boolean>) => {
      const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<any>>()
      registerConnectorHandlers(
        { handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never,
        svc,
        async () => {
          dialogs++
          return path.join(FIX, 'calendar.ics')
        },
        async () => true,
        confirm ? { consent: confirm } : {}
      )
      return (ch: string, raw?: unknown) => handlers.get(ch)!({ sender: null }, raw)
    }
    const none = reg()
    const pick = await none('lens:connectors:pick', { kind: 'calendar' })
    expect(pick).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(dialogs).toBe(0)
    expect(await none('lens:connectors:consent-grant', { kind: 'calendar' })).toMatchObject({ ok: false })
    expect((await none('lens:connectors:consent-grant', { kind: 'gmail' })).ok).toBe(false)
    const asked: string[] = []
    const no = reg(async (k) => {
      asked.push(k)
      return false
    })
    expect(await no('lens:connectors:consent-grant', { kind: 'calendar' })).toMatchObject({ ok: false })
    expect(svc.consent.get('calendar').granted).toBe(false)
    const yes = reg(async (k) => {
      asked.push(k)
      return true
    })
    expect(await yes('lens:connectors:consent-grant', { kind: 'calendar' })).toMatchObject({ ok: true, data: { kind: 'calendar', granted: true } })
    expect(asked).toEqual(['calendar', 'calendar'])
    expect((await yes('lens:connectors:pick', { kind: 'calendar' })).ok).toBe(true)
    expect(dialogs).toBe(1)
    const st = await yes('lens:connectors:consent-status')
    expect(st.data.find((c: { kind: string }) => c.kind === 'calendar').granted).toBe(true)
    expect(await yes('lens:connectors:consent-revoke', { kind: 'calendar' })).toMatchObject({ ok: true, data: { granted: false } })
    expect((await yes('lens:connectors:pick', { kind: 'calendar' })).ok).toBe(false)
    rmTmp(storeRoot)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('consent text and the missing-consent error default to English', async () => {
    const { svc } = setup()
    expect(svc.consent.get('imap').text.title).toBe('IMAP mailbox (app password, read-only)')
    await expect(svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))).rejects.toThrow(/Agree to the "Calendar \(\.ics file\)" connector terms/)
  })
})
