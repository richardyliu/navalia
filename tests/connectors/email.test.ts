// S1-R4-07 local .eml / mbox connector. Fixtures are synthetic (tests/connectors/fixtures).
// The Runtime is a TEST DOUBLE (records `remember` inputs); every path is a mkdtemp dir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countAddresses, decodeHeaderValue, decodeQuotedPrintable, htmlToText, MailParseError, parseEmail, parseParams } from '../../src/main/connectors/eml'
import { looksLikeMbox, parseMbox, splitMbox } from '../../src/main/connectors/mbox'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { grantAll } from './consent-helper'
import { createConnectorService } from '../../src/main/connectors/service'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, 'fixtures')
const EML = path.join(FIX, 'multipart.eml')
const MBOX = path.join(FIX, 'small.mbox')
const roots: string[] = []
const tmp = (l: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lens-mail-${l}-`))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const raw = (f: string): string => fs.readFileSync(f).toString('latin1')

function setup(opts: { failAt?: number } = {}) {
  const storeRoot = tmp('store')
  const remembered: Array<{ content: string; tags: string }> = []
  let n = 0
  const svc = createConnectorService({
    storeRoot,
    runtimeRoot: () => tmp('rt'),
    persomeBin: () => null,
    ossTool: async (name, args) => {
      if (name !== 'remember') throw new Error(`unexpected tool ${name}`)
      n++
      if (opts.failAt === n) throw new Error('Runtime MCP 断开')
      remembered.push(args as { content: string; tags: string })
      return JSON.stringify({ entry_id: `m-${n}` })
    },
    postRuntime: async () => {
      throw new Error('email must never call REST')
    }
  })
  grantAll(svc)
  return { svc, remembered, storeRoot }
}

describe('MIME helpers', () => {
  it('RFC 2047 B / Q words (adjacent words joined), raw UTF-8 headers, unknown charsets', () => {
    expect(decodeHeaderValue('=?UTF-8?B?5L2g5aW9?= =?UTF-8?Q?_=E4=B8=96=E7=95=8C?=')).toBe('你好 世界')
    expect(decodeHeaderValue('=?ISO-8859-1?Q?Caf=E9?= au lait')).toBe('Café au lait')
    expect(decodeHeaderValue('=?gb2312?B?1tDOxA==?=')).toBe('中文')
    expect(decodeHeaderValue(Buffer.from('直接 UTF-8', 'utf8').toString('latin1'))).toBe('直接 UTF-8')
    expect(decodeHeaderValue('=?x-nope?Q?abc?=')).toBe('abc')
  })

  it('quoted-printable soft breaks and escapes; params with quotes and RFC 2231 continuations', () => {
    expect(decodeQuotedPrintable('a=3Db=\r\nc =E2=9C=93').toString('utf8')).toBe('a=bc ✓')
    expect(decodeQuotedPrintable('bad =ZZ').toString('latin1')).toBe('bad =ZZ')
    const p = parseParams('attachment; filename*0*=utf-8\'\'%E5%91%A8; filename*1*=%E6%8A%A5.pdf; x="a;b"')
    expect(p).toEqual({ value: 'attachment', params: { filename: '周报.pdf', x: 'a;b' } })
    expect(countAddresses('"Wang, Wu" <w@x>, b@x, <c@x>')).toBe(3)
    expect(countAddresses(null)).toBe(0)
  })

  it('HTML fallback drops script / style and decodes entities', () => {
    expect(htmlToText('<style>x{}</style><p>a &amp; b &lt;c&gt;</p><script>evil()</script>&#20013;').trim()).toBe('a & b <c>\n中')
  })
})

describe('.eml parser', () => {
  it('multipart/mixed + alternative: text/plain preferred (QP), RFC 2047 subject / from, attachments named only', () => {
    const m = parseEmail(raw(EML))
    expect(m.messageId).toBe('zephyrquill-week3.20261103@lens.example.invalid')
    expect(m.subject).toBe('项目周报：Zephyrquill 进度第 3 周')
    expect(m.from).toBe('李四 <synthetic.person@example.com>')
    expect(m.to).toContain('"Wang, Wu"')
    expect(m.ccCount).toBe(2)
    expect(m.date).toBe('2026-11-03T02:15:00.000Z')
    expect(m.bodySource).toBe('plain')
    expect(m.body).toContain('这是 Zephyrquill 项目第 3 周的进度')
    // QP soft line breaks are joined (the long line is one line again).
    expect(m.body).toMatch(/很长很长.*用来测试软换行/)
    expect(m.body).not.toContain('HTML_ONLY_MARKER')
    expect(m.attachments).toEqual(['周报.pdf', '（未命名 image/png）'])
    expect(JSON.stringify(m)).not.toMatch(/ATTACHMENT_CONTENT_MARKER|PNG_BYTES_MARKER/)
  })

  it('empty and non-email inputs are errors', () => {
    expect(() => parseEmail('')).toThrow(MailParseError)
    expect(() => parseEmail('   \n\n')).toThrow(/空/)
    expect(() => parseEmail('just some text\nwithout headers\n')).toThrow(/不像一封邮件/)
    expect(() => parseEmail('X-Foo: 1\n\nbody')).toThrow(/不像一封邮件/)
  })

  it('tolerates a missing body, a bad Date and an unterminated multipart', () => {
    expect(parseEmail('Subject: only headers\n')).toMatchObject({ subject: 'only headers', body: '', bodySource: 'none' })
    const bad = parseEmail('Subject: x\nDate: not a date\n\nhello')
    expect(bad.date).toBeNull()
    expect(bad.warnings.join()).toMatch(/Date/)
    const open = parseEmail('Subject: y\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nstill read\n')
    expect(open.body).toBe('still read')
  })
})

describe('mbox parser', () => {
  it('splits on envelope lines, unquotes >From, decodes base64 HTML-only and latin-1 QP messages', () => {
    const text = raw(MBOX)
    expect(looksLikeMbox(text)).toBe(true)
    expect(looksLikeMbox(raw(EML))).toBe(false)
    expect(splitMbox(text)).toHaveLength(3)
    const r = parseMbox(text)
    expect(r.skipped).toEqual([])
    const [plain, html, latin] = r.messages
    expect(plain.body).toContain('\nFrom the archive: this line was quoted')
    expect(plain.body).toContain('\n>From stays quoted once.')
    expect(html.subject).toBe('Café HTML')
    expect(html.bodySource).toBe('html')
    expect(html.body).toContain('Brindlewhorl 只有 HTML 的邮件 & 实体 <ok>')
    expect(html.body).not.toContain('alert')
    expect(latin.messageId).toBeNull()
    expect(latin.body).toBe('Le café est prêt.')
  })

  it('a malformed message inside an mbox is skipped with a warning; empty / non-mbox are errors', () => {
    const r = parseMbox(`${raw(MBOX)}\nFrom junk Mon Nov  2 12:00:00 2026\nthis is not a message\n`)
    expect(r.messages).toHaveLength(3)
    expect(r.skipped).toEqual([{ index: 4, reason: expect.stringMatching(/不像一封邮件/) }])
    expect(r.warnings.join()).toMatch(/1 封邮件无法解析/)
    expect(() => parseMbox('')).toThrow(/空/)
    expect(() => parseMbox('Subject: x\n\nbody')).toThrow(/不是 mbox/)
  })
})

describe('email connector service', () => {
  it('preview is redacted, lists attachment names only and writes nothing', async () => {
    const { svc, remembered, storeRoot } = setup()
    const p = await svc.previewFile('email', EML)
    expect(p).toMatchObject({ kind: 'email', fileName: 'multipart.eml', totals: { items: 1, events: 1 } })
    const [it] = p.items
    expect(it.key).toMatch(/^mail-[0-9a-f]{24}$/)
    expect(it.state).toBe('new')
    expect(it.attachments).toBe(2)
    expect(it.title).toBe('项目周报：Zephyrquill 进度第 3 周')
    expect(it.text).toContain('邮件：项目周报：Zephyrquill 进度第 3 周')
    expect(it.text).toContain('发件人：李四 <[email]>')
    expect(it.text).toContain('抄送：2 人')
    expect(it.text).toContain('时间：2026-11-03 02:15（UTC）')
    expect(it.text).toContain('附件：2 个（周报.pdf、（未命名 image/png））· 只记文件名，未读取附件内容')
    for (const secret of ['sk-ant-api03-FAKE', 'synthetic.person@example.com', 'wangwu@example.com', 'a@example.com', '138 0013 8000', 'ATTACHMENT_CONTENT_MARKER', 'HTML_ONLY_MARKER']) {
      expect(it.text).not.toContain(secret)
    }
    expect(it.redactions).toBeGreaterThanOrEqual(4)
    expect(p.mapping.join('\n')).toMatch(/remember/)
    expect(p.mapping.join('\n')).toMatch(/附件只记文件名/)
    expect(fs.existsSync(svc.paths.ledgerPath)).toBe(false)
    expect(remembered).toHaveLength(0)
  })

  it('commit → one remember per message with email tags; re-import (same or other file) adds nothing', async () => {
    const { svc, remembered, storeRoot } = setup()
    const p = await svc.previewFile('email', MBOX)
    expect(p.items).toHaveLength(3)
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r).toMatchObject({ kind: 'email', target: 'email', written: 3, failed: 0 })
    expect(remembered.map((x) => x.tags)).toEqual(Array(3).fill('lens-connector,connector:email'))
    expect(remembered.map((x) => x.content)).toEqual(p.items.map((i) => i.text))
    expect(fs.statSync(svc.paths.ledgerPath).mode & 0o777).toBe(0o600)

    // Same file again: all unchanged, nothing written.
    const p2 = await svc.previewFile('email', MBOX)
    expect(p2.items.map((i) => i.key)).toEqual(p.items.map((i) => i.key))
    expect(p2.items.every((i) => i.state === 'unchanged')).toBe(true)
    expect(await svc.commit(p2.previewId!, p2.items.map((i) => i.key), {})).toMatchObject({ written: 0, unchanged: 3 })

    // The first message saved as its own .eml under another name: same Message-ID → unchanged.
    const dir = tmp('copy')
    const one = path.join(dir, 'exported-copy.eml')
    fs.writeFileSync(one, splitMbox(raw(MBOX))[0], 'latin1')
    const p3 = await svc.previewFile('email', one)
    expect(p3.items[0]).toMatchObject({ key: p.items[0].key, state: 'unchanged' })
    // A message with the same Message-ID but edited content is "changed" → one 更新 entry.
    const edited = path.join(dir, 'edited.eml')
    fs.writeFileSync(edited, splitMbox(raw(MBOX))[0].replace('First line', 'Edited first line'), 'latin1')
    const p4 = await svc.previewFile('email', edited)
    expect(p4.items[0]).toMatchObject({ key: p.items[0].key, state: 'changed' })
    const r4 = await svc.commit(p4.previewId!, [p4.items[0].key], {})
    expect(r4).toMatchObject({ updated: 1, written: 0 })
    expect(remembered).toHaveLength(4)
    expect(remembered[3].content.startsWith('（更新）')).toBe(true)
    expect(fs.readdirSync(storeRoot)).toEqual(['connectors'])
  })

  it('the key of a message without Message-ID is stable across re-reads', async () => {
    const a = (await setup().svc.previewFile('email', MBOX)).items.find((i) => i.title.startsWith('No message id'))!
    const b = (await setup().svc.previewFile('email', MBOX)).items.find((i) => i.title.startsWith('No message id'))!
    expect(a.key).toBe(b.key)
  })

  it('duplicate Message-IDs inside one mbox are written once', async () => {
    const { svc } = setup()
    const dir = tmp('dup')
    const f = path.join(dir, 'dup.mbox')
    const first = raw(MBOX).split('\n\nFrom ')[0]
    fs.writeFileSync(f, `${first}\n\n${first}\n`, 'latin1')
    const p = await svc.previewFile('email', f)
    expect(p.items).toHaveLength(1)
    expect(p.totals.events).toBe(2)
    expect(p.warnings.join()).toMatch(/重复的邮件/)
  })

  it('error states: empty, non-email, symlink, oversized; a failed remember is reported and retried later', async () => {
    const { svc, remembered } = setup({ failAt: 2 })
    const dir = tmp('bad')
    const empty = path.join(dir, 'empty.eml')
    fs.writeFileSync(empty, '')
    await expect(svc.previewFile('email', empty)).rejects.toThrow(/empty\.eml.*空/)
    const junk = path.join(dir, 'notes.eml')
    fs.writeFileSync(junk, 'hello\nworld\n')
    await expect(svc.previewFile('email', junk)).rejects.toThrow(/不像一封邮件/)
    const emptyMbox = path.join(dir, 'empty.mbox')
    fs.writeFileSync(emptyMbox, 'From x Mon Nov  2 09:00:00 2026\njunk without headers\n')
    await expect(svc.previewFile('email', emptyMbox)).rejects.toThrow(/没有.*可导入的邮件/)
    const link = path.join(dir, 'link.eml')
    fs.symlinkSync(EML, link)
    await expect(svc.previewFile('email', link)).rejects.toThrow(/符号链接/)
    await expect(svc.previewFile('email', 'relative.eml')).rejects.toThrow(/绝对路径/)

    const p = await svc.previewFile('email', MBOX)
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r).toMatchObject({ written: 2, failed: 1 })
    expect(r.items.find((i) => i.outcome === 'failed')!.detail).toMatch(/断开/)
    const p2 = await svc.previewFile('email', MBOX)
    expect(p2.items.filter((i) => i.state === 'new')).toHaveLength(1)
    const r2 = await svc.commit(p2.previewId!, p2.items.map((i) => i.key), {})
    expect(r2).toMatchObject({ written: 1, unchanged: 2 })
    expect(remembered).toHaveLength(3)
  })
})

describe('email connector IPC', () => {
  it('accepts kind email and mail- keys only; path never comes from the renderer; confirm required', async () => {
    const { svc } = setup()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<any>>()
    let picked: string | null = EML
    const confirms: unknown[] = []
    registerConnectorHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc, async () => picked, async (s) => {
      confirms.push(s)
      return true
    })
    const call = (ch: string, a?: unknown) => handlers.get(ch)!({}, a)
    expect((await call('lens:connectors:pick', { kind: 'gmail' })).ok).toBe(false)
    expect((await call('lens:connectors:pick', { kind: 'email', path: EML })).ok).toBe(false)
    const p = await call('lens:connectors:pick', { kind: 'email' })
    expect(p.ok).toBe(true)
    expect(JSON.stringify(p.data)).not.toContain(FIX)
    const keys = p.data.items.map((i: { key: string }) => i.key)
    expect((await call('lens:connectors:commit', { previewId: p.data.previewId, keys: ['mail-zz'], opts: {}, confirm: true })).ok).toBe(false)
    expect((await call('lens:connectors:commit', { previewId: p.data.previewId, keys, opts: {} })).ok).toBe(false)
    expect(await call('lens:connectors:commit', { previewId: p.data.previewId, keys, opts: {}, confirm: true })).toMatchObject({ ok: true, data: { written: 1 } })
    expect(confirms).toEqual([{ kind: 'email', items: 1, fileName: 'multipart.eml' }])
    picked = null
    expect(await call('lens:connectors:pick', { kind: 'email' })).toMatchObject({ ok: true, data: { cancelled: true } })
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('parse errors default to English', () => {
    expect(() => parseEmail('   \n\n')).toThrow(/The file is empty/)
    expect(() => parseEmail('X-Foo: 1\n\nbody')).toThrow(/Does not look like an email/)
  })
})
