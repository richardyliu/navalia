import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SWIPE_CHANNELS, registerSwipeIpc } from '../../src/main/identity/swipe'
import { matchQr, parseQrPayload, qrPayloadText } from '../../src/main/identity/swipe-schema'
import { createIssuedCard } from './card-helpers'
import { mode, tempRoot } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

type Handler = (event: unknown, arg?: unknown) => unknown

function setup(opts: { saveTo?: string | null; openFile?: string | null; card?: ReturnType<typeof createIssuedCard>['signed'] | null } = {}) {
  const dir = tempRoot('swipe')
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map<string, Handler>()
  const dialogs: string[] = []
  registerSwipeIpc({ handle: (c: string, f: Handler) => void handlers.set(c, f) } as never, {
    latestCard: () => (opts.card === undefined ? null : opts.card),
    issuerOf: () => 'current',
    saveDialog: async (o) => {
      dialogs.push(o.defaultPath)
      return opts.saveTo === undefined ? null : opts.saveTo
    },
    openDialog: async () => (opts.openFile === undefined ? null : opts.openFile),
    capture: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    downloadsDir: () => dir
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<any>
  return { dir, call, dialogs }
}

describe('Swipe QR payload', () => {
  test('payload is exactly {v, card_id, fp}: no card content', () => {
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const text = qrPayloadText(signed)
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'card_id', 'fp'])
    expect(text).not.toContain(signed.card.content.front.summary ?? '###')
    expect(text.length).toBeLessThan(140)
  })

  test('match / same key other card / different key / invalid', () => {
    const a = createIssuedCard()
    const b = createIssuedCard()
    cleanups.push(a.cleanup, b.cleanup)
    expect(matchQr(a.signed, qrPayloadText(a.signed))).toBe('match')
    expect(matchQr(a.signed, JSON.stringify({ v: 1, card_id: `card_${'0'.repeat(32)}`, fp: a.signed.card.issuer.fingerprint }))).toBe('same_key_other_card')
    expect(matchQr(a.signed, qrPayloadText(b.signed))).toBe('different_key')
    expect(matchQr(a.signed, '{"v":1,"card_id":"x","fp":"y"}')).toBe('invalid_qr')
    expect(parseQrPayload(`${qrPayloadText(a.signed)} `)).not.toBeNull()
    expect(parseQrPayload('{"v":1,"card_id":"card_' + '0'.repeat(32) + '","fp":"' + 'a'.repeat(64) + '","summary":"leak"}')).toBeNull()
  })
})

describe('Swipe IPC (dialogs in main)', () => {
  test('qr: null without a card; SVG + payload with one', async () => {
    expect((await setup().call(SWIPE_CHANNELS.qr)).data).toBeNull()
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const r = (await setup({ card: signed }).call(SWIPE_CHANNELS.qr)).data
    expect(r.payload).toBe(qrPayloadText(signed))
    expect(r.svg.startsWith('<svg')).toBe(true)
    expect(r.version).toBe(8)
  })

  test('export .navaliacard writes a file that verifies; cancel writes nothing; default name = card id', async () => {
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const out = path.join(tempRoot('export'), 'mine.navaliacard')
    cleanups.push(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
    const s = setup({ card: signed, saveTo: out })
    expect((await s.call(SWIPE_CHANNELS.export, { kind: 'card' })).data).toEqual({ saved: out })
    expect(s.dialogs[0]).toMatch(new RegExp(`${signed.card.card_id}\\.navaliacard$`))
    expect(mode(out)).toBe('644')
    const imp = setup({ openFile: out })
    expect((await imp.call(SWIPE_CHANNELS.importFile)).data).toMatchObject({ valid: true, file: out })
    const cancelled = setup({ card: signed, saveTo: null })
    expect((await cancelled.call(SWIPE_CHANNELS.export, { kind: 'qr' })).data).toEqual({ saved: null })
  })

  test('export png uses the capture rect; bad rect rejected by zod', async () => {
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const out = path.join(tempRoot('png'), 'c.png')
    cleanups.push(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
    const s = setup({ card: signed, saveTo: out })
    expect((await s.call(SWIPE_CHANNELS.export, { kind: 'png', rect: { x: 10, y: 20, width: 400, height: 280 } })).ok).toBe(true)
    expect([...fs.readFileSync(out).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await s.call(SWIPE_CHANNELS.export, { kind: 'png', rect: { x: -1, y: 0, width: 1, height: 1 } })).ok).toBe(false)
    expect((await s.call(SWIPE_CHANNELS.export, { kind: 'card', path: '/etc/passwd' })).ok).toBe(false)
  })

  test('import: tampered card → invalid with reason; oversized file refused; cancel → null', async () => {
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const dir = tempRoot('imp')
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const t = structuredClone(signed)
    t.card.content.front.as_of = '2030-01-01T00:00:00.000Z'
    fs.writeFileSync(path.join(dir, 't.navaliacard'), JSON.stringify(t))
    expect((await setup({ openFile: path.join(dir, 't.navaliacard') }).call(SWIPE_CHANNELS.importFile)).data).toMatchObject({ valid: false, reason: 'signature' })
    fs.writeFileSync(path.join(dir, 'big.navaliacard'), Buffer.alloc(2_000_001, 32))
    expect((await setup({ openFile: path.join(dir, 'big.navaliacard') }).call(SWIPE_CHANNELS.importFile)).ok).toBe(false)
    expect((await setup().call(SWIPE_CHANNELS.importFile)).data).toBeNull()
  })
})
