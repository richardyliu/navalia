// C18 renderer view-model + static guarantees: fixed reflective prompts (Lens never writes about a
// moment), form checks, and scans that the moments UI never touches the network, never signs, and
// that the main-side moments code has no LLM / Runtime / inference inputs.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { MOMENT_PROMPTS } from '../../src/main/cloud/moments-api'
import {
  emptyForm,
  formProblem,
  insertPrompt,
  proposeArgs,
  rejectedBanner,
  unknownSignerText
} from '../../src/renderer/src/components/moments/momentsView'

const FP = 'b'.repeat(64)

describe('help expressing, not speaking for the user', () => {
  afterEach(() => setLocale('en'))

  it('prompts follow the UI language (English by default)', () => {
    expect(MOMENT_PROMPTS).toHaveLength(4)
    expect(MOMENT_PROMPTS[0]).toBe('What detail do you remember most from that day?')
    expect(insertPrompt('', MOMENT_PROMPTS[1])).toContain('One thing you want to say to them?')
  })

  it('prompts are a fixed list of questions; inserting one only adds that question to the user text', () => {
    setLocale('zh')
    expect([...MOMENT_PROMPTS]).toEqual(['那天最记得的一个细节是？', '想对 TA 说的一句话？', '那天之后，有什么想法变了吗？', '如果再来一次，想一起做什么？'])
    expect(Object.isFrozen(MOMENT_PROMPTS) || Array.isArray(MOMENT_PROMPTS)).toBe(true)
    const t1 = insertPrompt('', MOMENT_PROMPTS[0])
    expect(t1).toBe('「那天最记得的一个细节是？」\n')
    const t2 = insertPrompt(`${t1}风很大`, MOMENT_PROMPTS[1])
    expect(t2).toBe('「那天最记得的一个细节是？」\n风很大\n\n「想对 TA 说的一句话？」\n')
    expect(insertPrompt(t2, MOMENT_PROMPTS[1])).toBe(t2) // no duplicates
    expect(insertPrompt('x', '替我写一段回忆')).toBe('x') // only the fixed prompts
  })

  it('no generation path: moments main code takes no LLM / Runtime / chat input', () => {
    const dir = path.resolve('src/main/cloud')
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('moments'))) {
      // code only (comments may say "no LLM")
      const src = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      expect(src, f).not.toMatch(/ossTool|runtime\(|chat|completions|llm/i)
    }
    const ui = path.resolve('src/renderer/src/components/moments')
    for (const f of fs.readdirSync(ui)) {
      const src = fs.readFileSync(path.join(ui, f), 'utf8')
      expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(src), f).toBe(false)
      expect(/canonicalize|\.sign\(|signature: [a-z]/.test(src), f).toBe(false)
      expect(/window\.lens\.(chat|mcp)/.test(src), f).toBe(false)
    }
  })
})

describe('propose form', () => {
  beforeEach(() => setLocale('zh'))
  afterEach(() => setLocale('en'))

  it('validates title / dates / lengths; place blank ⇒ null; private by default', () => {
    const f = emptyForm('2026-11-05')
    expect(f.visibility).toBe('private')
    expect(formProblem(f)).toBe('请写一个标题')
    expect(formProblem({ ...f, title: 'a\nb' })).toBe('标题只能一行')
    expect(formProblem({ ...f, title: 'x', start: '2026-11-06' })).toBe('开始日期不能晚于结束日期')
    expect(formProblem({ ...f, title: 'x', start: '2026-02-30', end: '2026-02-30' })).toBe('日期格式是 YYYY-MM-DD')
    expect(formProblem({ ...f, title: 'x', note: 'n'.repeat(4001) })).toBe('附言最多 4000 字')
    expect(formProblem({ ...f, title: ' 香山 ' })).toBeNull()
    expect(proposeArgs(FP, { ...f, title: ' 香山 ', place: '  ' })).toEqual({
      friendFingerprint: FP,
      title: '香山',
      start: '2026-11-05',
      end: '2026-11-05',
      place: null,
      note: '',
      visibility: 'private'
    })
  })

  it('labels', () => {
    expect(unknownSignerText()).toBe('签名者不在朋友列表')
    setLocale('en')
    expect(unknownSignerText()).toBe('Signer is not in your Peers list')
    setLocale('zh')
    expect(rejectedBanner([])).toBeNull()
    expect(rejectedBanner([{ file: 'x.json', reason: 'signature' }])).toContain('x.json（签名无效）')
  })
})
