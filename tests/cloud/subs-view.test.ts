// 订阅 page view-model (pure) + static scan: the subs renderer files never touch the network.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import {
  cardFetchText,
  cloudCardStatusText,
  countsText,
  deliveryStatusLabel,
  draftProblem,
  droppedLines,
  noTrackingNote,
  parseFingerprint,
  placeholderCount,
  shortFp,
  subscriberStatusLabel,
  subsErrorText,
  subsGate
} from '../../src/renderer/src/pages/subscriptionsView'

const FP = 'ab'.repeat(32)

describe('subscriptionsView (English default)', () => {
  it('labels, counts and errors', () => {
    expect(deliveryStatusLabel('sent')).toBe('Sent')
    expect(countsText({ queued: 1, sent: 3, failed: 1, suppressed: 0 })).toBe('3 sent · 1 queued · 1 failed (5 total)')
    expect(noTrackingNote()).toBe('No open/read tracking; every email has an unsubscribe link')
    expect(droppedLines([{ index: 2, reason: 'wrong_signer', issueId: null }])).toEqual(['Invalid signature, discarded: letter 3 · Signer is not this friend'])
    expect(draftProblem({ title: '  ', markdown: 'm', week: '2026-W45' })).toBe('Title cannot be empty')
    expect(subsErrorText({ code: 'no_card', message: 'm' })).toBe('m. Generate one on the Personal Card page.')
  })
})

describe('subscriptionsView', () => {
  beforeEach(() => setLocale('zh'))
  afterEach(() => setLocale('en'))

  it('gate: loading / off / signed_out / ready', () => {
    expect(subsGate(null)).toEqual({ state: 'loading' })
    expect(subsGate({ enabled: false, baseUrl: null, signedIn: false, accountId: null, expiresAt: null })).toMatchObject({ state: 'off' })
    expect(subsGate({ enabled: true, baseUrl: 'https://c.example', signedIn: false, accountId: null, expiresAt: null })).toMatchObject({ state: 'signed_out', text: expect.stringContaining('https://c.example') })
    expect(subsGate({ enabled: true, baseUrl: 'https://c.example', signedIn: true, accountId: 'a', expiresAt: 'x' })).toMatchObject({ state: 'ready' })
  })

  it('parseFingerprint accepts pasted forms, rejects anything else', () => {
    expect(parseFingerprint(`  ${FP.toUpperCase()} `)).toBe(FP)
    expect(parseFingerprint(FP.match(/.{4}/g)!.join(' '))).toBe(FP)
    expect(parseFingerprint(FP.match(/.{2}/g)!.join(':'))).toBe(FP)
    expect(parseFingerprint(FP.slice(1))).toBeNull()
    expect(parseFingerprint(`${FP.slice(1)}g`)).toBeNull()
    expect(shortFp(FP)).toBe(`${FP.slice(0, 8)}…${FP.slice(-8)}`)
  })

  it('labels and counts', () => {
    expect(deliveryStatusLabel('sent')).toBe('已发送')
    expect(deliveryStatusLabel('suppressed')).toContain('退订')
    expect(deliveryStatusLabel('weird')).toBe('weird')
    expect(subscriberStatusLabel('pending')).toBe('等待邮件确认')
    expect(countsText({ queued: 0, sent: 0, failed: 0, suppressed: 0 })).toBe('没有收件人')
    expect(countsText({ queued: 1, sent: 3, failed: 1, suppressed: 0 })).toBe('已发送 3 · 排队 1 · 失败 1（共 5）')
    expect(noTrackingNote()).toBe('不追踪打开/阅读；每封邮件都有退订链接')
  })

  it('dropped letters are reported with 「签名无效，已丢弃」', () => {
    const lines = droppedLines([
      { index: 0, reason: 'signature', issueId: '0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e61' },
      { index: 2, reason: 'wrong_signer', issueId: null }
    ])
    expect(lines).toEqual(['签名无效，已丢弃：第 1 封（0b7f2c1e） · 签名验证失败', '签名无效，已丢弃：第 3 封 · 签名者不是这位朋友'])
  })

  it('draft checks mirror the IPC limits', () => {
    const ok = { title: 't', markdown: 'm', week: '2026-W45' }
    expect(draftProblem(ok)).toBeNull()
    expect(draftProblem({ ...ok, title: '  ' })).toContain('标题')
    expect(draftProblem({ ...ok, markdown: 'x'.repeat(30_001) })).toContain('30000')
    expect(draftProblem({ ...ok, week: '2026-45' })).toContain('YYYY-Www')
    expect(placeholderCount('a <!-- x --> b <!--\ny--> c')).toBe(2)
  })

  it('card texts', () => {
    expect(cardFetchText({ outcome: 'added', fingerprint: FP, displayName: null, versions: 1, cloudVersion: 3, publishedAt: 'x' })).toBe(`${shortFp(FP)}：验签通过，已加入朋友列表（本地共 1 个版本；云端第 3 版）`)
    expect(cloudCardStatusText(null)).toBe('')
    expect(cloudCardStatusText({ published: false, version: null, publishedAt: null, cardId: null, verified: false, matchesLatest: false })).toBe('还没有发布到云端')
    expect(cloudCardStatusText({ published: true, version: 2, publishedAt: 'x', cardId: null, verified: false, matchesLatest: false })).toContain('验签失败')
    expect(cloudCardStatusText({ published: true, version: 2, publishedAt: 'x', cardId: 'c', verified: true, matchesLatest: true })).toContain('一致')
    expect(subsErrorText({ code: 'no_card', message: 'm' })).toContain('个人卡片')
    expect(subsErrorText({ code: 'server', message: 'm' })).toBe('m')
  })
})

describe('static scan: subs renderer files', () => {
  it('never call fetch / open sockets, and the page has its own css', () => {
    const files = [
      'src/renderer/src/pages/Subscriptions.tsx',
      'src/renderer/src/pages/subscriptionsView.ts',
      ...fs.readdirSync(path.resolve('src/renderer/src/components/subs')).map((f) => `src/renderer/src/components/subs/${f}`)
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), 'utf8')
      expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(src), f).toBe(false)
      // The renderer never builds or sends signatures / envelopes itself.
      expect(/\bsign\s*\(|signLetter|canonicalize|letterSigning|node:crypto/.test(src), f).toBe(false)
    }
    expect(fs.readFileSync(path.resolve('src/renderer/src/pages/Subscriptions.tsx'), 'utf8')).toContain("import './Subscriptions.css'")
  })
})
