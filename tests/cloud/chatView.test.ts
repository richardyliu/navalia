// Chat page view-model (pure; no DOM): citation parsing on accumulated text, totals text, gate,
// stream reducer, usage text.
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { ChatContextItem } from '../../src/main/cloud/chat-api'
import {
  errorText,
  gateOf,
  parseCitations,
  reduceStream,
  replyUsageText,
  startStream,
  statusLabel,
  totalsText,
  usageText
} from '../../src/renderer/src/pages/chatView'

const item = (id: string, chars: number): ChatContextItem => ({ id, kind: 'memory', title: 't', text: 'x', ref: null, chars })

describe('chatView', () => {
  it('parseCitations: text / cite segments, grouped ids, unknown ids flagged', () => {
    const segs = parseCitations('A [ctx-1] B [ctx-2, ctx-9]。C', new Set(['ctx-1', 'ctx-2']))
    expect(segs).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'cite', id: 'ctx-1', known: true },
      { type: 'text', text: ' B ' },
      { type: 'cite', id: 'ctx-2', known: true },
      { type: 'cite', id: 'ctx-9', known: false },
      { type: 'text', text: '。C' }
    ])
    expect(parseCitations('no cites')).toEqual([{ type: 'text', text: 'no cites' }])
    expect(parseCitations('[ctx-x] [ctx-]')).toEqual([{ type: 'text', text: '[ctx-x] [ctx-]' }])
  })

  it('markers split across deltas render only once accumulated', () => {
    const deltas = ['（mock）收', '到 1 条上下文', '。\n- t [c', 'tx-1]']
    let s = startStream('s1', 'c-1')
    for (const d of deltas.slice(0, 3)) s = reduceStream(s, { streamId: 's1', type: 'delta', text: d })!
    expect(parseCitations(s.text).some((x) => x.type === 'cite')).toBe(false)
    s = reduceStream(s, { streamId: 's1', type: 'delta', text: deltas[3] })!
    expect(parseCitations(s.text).filter((x) => x.type === 'cite')).toEqual([{ type: 'cite', id: 'ctx-1', known: true }])
  })

  it('reduceStream ignores other streams; usage / error / end', () => {
    const s = startStream('s1', 'c-1')
    expect(reduceStream(s, { streamId: 'other', type: 'delta', text: 'x' })).toBe(s)
    expect(reduceStream(null, { streamId: 's1', type: 'delta', text: 'x' })).toBeNull()
    const u = reduceStream(s, { streamId: 's1', type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 2, model: 'm', estimated: true } })!
    expect(replyUsageText(u.usage)).toBe('m · in 1 / out 2 tokens (estimated)')
    const e = reduceStream(u, { streamId: 's1', type: 'error', code: 'upstream_error', message: 'm' })!
    expect(e.error).toEqual({ code: 'upstream_error', message: 'm' })
    expect(reduceStream(e, { streamId: 's1', type: 'end', status: 'error', conversationId: 'c-1' })!.ended).toBe('error')
  })

  it('totalsText counts only selected items', () => {
    const items = [item('ctx-1', 1200), item('ctx-2', 30), item('ctx-3', 5)]
    expect(totalsText(items, new Set(['ctx-1', 'ctx-3']))).toBe('Will send 2 item(s), 1,205 characters in total')
    expect(totalsText(items, new Set())).toBe('Will send 0 item(s), 0 characters in total')
  })

  it('gate / status / error / usage text', () => {
    expect(gateOf(null)).toEqual({ state: 'loading' })
    expect(gateOf({ enabled: false, baseUrl: null, signedIn: false, accountId: null, expiresAt: null }).state).toBe('off')
    expect(gateOf({ enabled: true, baseUrl: 'https://a', signedIn: false, accountId: null, expiresAt: null }).state).toBe('signed_out')
    expect(gateOf({ enabled: true, baseUrl: 'https://a', signedIn: true, accountId: 'x', expiresAt: 'y' }).state).toBe('ready')
    expect(statusLabel('complete')).toBe('')
    expect(statusLabel('cancelled')).toContain('incomplete')
    expect(errorText({ code: 'quota_exceeded', message: "Today's cloud quota is used up" })).toContain('Try again tomorrow')
    expect(errorText({ code: 'weird', message: 'm' })).toBe('m')
    expect(usageText({ day: '2026-11-05', prompt_tokens: 100, completion_tokens: 23, limit: 100000 })).toBe('Today (2026-11-05): 123 / 100,000 tokens used')
    expect(usageText({ day: 'd', prompt_tokens: 1, completion_tokens: 1, limit: null })).toBe('Today (d): 2 tokens used')
  })

  describe('zh locale', () => {
    afterEach(() => setLocale('en'))
    it('keeps the original Chinese text', () => {
      setLocale('zh')
      expect(statusLabel('cancelled')).toContain('不完整')
      expect(errorText({ code: 'quota_exceeded', message: '今天的云端用量已用完' })).toBe('今天的云端用量已用完。明天再试，或联系服务器管理员提高额度。')
      expect(totalsText([item('ctx-1', 1200)], new Set(['ctx-1']))).toBe('将发送 1 条、共 1,200 字符')
      expect(usageText({ day: 'd', prompt_tokens: 1, completion_tokens: 1, limit: null })).toBe('今天（d）已用 2 tokens')
      expect(replyUsageText({ prompt_tokens: 1, completion_tokens: 2, model: 'm', estimated: true })).toBe('m · 输入 1 / 输出 2 tokens（估算）')
    })
  })
})
