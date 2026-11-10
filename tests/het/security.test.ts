import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { readClaudeProjects } from './readers'
import { readLinesFrom, readTextReadOnly, TranscriptReadError } from '../../src/main/het/adapters/common'
import { buildAssessorPrompt, type AssessorEvidence, type AssessorTaskView } from '../../src/main/het/assessor'
import { openHetDb } from '../../src/main/het/ledger'
import { DEFAULT_HET_SETTINGS, HetSettingsSchema } from '../../src/main/het/settings'
import { writeExportPair } from '../../src/main/het/service'
import { createTranscriptSource } from '../../src/main/het/sources'
import { mdCell } from '../../src/main/het/weekly'

const FIX = join(__dirname, '..', 'fixtures', 'het', 'claude')
const S1 = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'het-sec-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const mode = (f: string): number => statSync(f).mode & 0o777

describe('#4 het.db and WAL/SHM are 0600', () => {
  test('fresh db + side files', () => {
    const d = tmp()
    const f = join(d, 'het.db')
    const db = openHetDb(f, 0)
    db.prepare("INSERT INTO het_meta (key, value) VALUES ('x', 'y')").run()
    for (const p of [f, `${f}-wal`, `${f}-shm`]) expect(mode(p), p).toBe(0o600)
    db.close()
  })
  test('pre-existing 0644 db is tightened on open', () => {
    const d = tmp()
    const f = join(d, 'het.db')
    openHetDb(f, 0).close()
    require('node:fs').chmodSync(f, 0o644)
    const db = openHetDb(f, 0)
    expect(mode(f)).toBe(0o600)
    db.close()
  })
})

describe('#7 weekly export: no clobber, inert Markdown', () => {
  test('wx + suffix fallback keeps existing files', () => {
    const d = tmp()
    writeFileSync(join(d, 'w.html'), 'USER FILE')
    const r1 = writeExportPair(join(d, 'w.md'), '# md', '<p>h</p>')
    expect(r1).toEqual({ mdPath: join(d, 'w-1.md'), htmlPath: join(d, 'w-1.html') })
    expect(readFileSync(join(d, 'w.html'), 'utf8')).toBe('USER FILE')
    const r2 = writeExportPair(join(d, 'w.md'), '# md2', '<p>h2</p>')
    expect(r2.mdPath).toBe(join(d, 'w-2.md'))
    expect(mode(r2.mdPath)).toBe(0o600)
  })
  test('cells cannot form images, links, HTML or code spans', () => {
    const cell = mdCell('![](https://x/p) [a](b) <img src=x> `code` a|b *em* _u_')
    expect(cell).not.toMatch(/(^|[^\\])!\[/)
    expect(cell).not.toMatch(/(^|[^\\])\[/)
    expect(cell).not.toMatch(/(^|[^\\])</)
    expect(cell).not.toMatch(/(^|[^\\])`/)
    expect(cell).not.toMatch(/(^|[^\\])\|/)
    expect(cell).toBe('\\!\\[\\](https://x/p) \\[a\\](b) \\<img src=x\\> \\`code\\` a\\|b \\*em\\* \\_u\\_')
  })
})

describe('#8 safe transcript reads', () => {
  test('symlinks are refused (O_NOFOLLOW), directories are not regular files', () => {
    const d = tmp()
    const real = join(d, 'real.jsonl')
    writeFileSync(real, '{}\n')
    symlinkSync(real, join(d, 'link.jsonl'))
    expect(() => readTextReadOnly(join(d, 'link.jsonl'))).toThrow(TranscriptReadError)
    mkdirSync(join(d, 'dir.jsonl'))
    try {
      readTextReadOnly(join(d, 'dir.jsonl'))
      expect.unreachable()
    } catch (e) {
      expect((e as TranscriptReadError).code).toBe('not_regular_file')
    }
  })
  test('size cap → file_too_large warning, not a crash', () => {
    const d = tmp()
    const p = join(d, 'proj')
    mkdirSync(p)
    writeFileSync(join(p, 'big.jsonl'), 'x'.repeat(1000) + '\n')
    expect(() => readTextReadOnly(join(p, 'big.jsonl'), 100)).toThrow('file_too_large')
  })
  test('a single line longer than the cap is skipped (line_too_large), later lines still parse', async () => {
    const d = tmp()
    mkdirSync(join(d, 'p'))
    const f = join(d, 'p', 'x.jsonl')
    const ok = (m: number) => JSON.stringify({ type: 'user', sessionId: 's', cwd: '/w', timestamp: `2025-09-01T10:0${m}:00.000Z`, message: { role: 'user', content: `p${m}` } })
    writeFileSync(f, [ok(1), JSON.stringify({ type: 'user', pad: 'z'.repeat(5000) }), ok(2)].join('\n') + '\n')
    const src = createTranscriptSource({ claudeRoot: d, codexRoot: join(d, 'none'), maxBytesPerFile: 1000 })
    let r = await src.refresh()
    for (let i = 0; i < 10 && r.partial > 0; i++) r = await src.refresh()
    expect(r.events.map((e) => [e.summary, e.source.line])).toEqual([['p1', 1], ['p2', 3]])
    expect(r.warnings.line_too_large).toBe(1)
  })

  test('readLinesFrom returns complete lines only', () => {
    const d = tmp()
    const f = join(d, 'a.jsonl')
    writeFileSync(f, 'one\ntwo\nthr')
    const r = readLinesFrom(f, 0)
    expect(r).toMatchObject({ text: 'one\ntwo\n', endOffset: 8, complete: true })
    const r2 = readLinesFrom(f, 0, 5)
    expect(r2).toMatchObject({ text: 'one\n', endOffset: 4, complete: false })
  })

  function copyFixtures(): string {
    const d = tmp()
    const dst = join(d, 'claude', '-work-demo-app')
    mkdirSync(join(dst, S1, 'subagents'), { recursive: true })
    mkdirSync(join(d, 'claude', '-work-other'))
    for (const rel of [`-work-demo-app/${S1}.jsonl`, `-work-demo-app/${S1}/subagents/agent-a1.jsonl`, '-work-demo-app/22222222-2222-4222-8222-222222222222.jsonl', '-work-other/33333333-3333-4333-8333-333333333333.jsonl'])
      copyFileSync(join(FIX, rel), join(d, 'claude', rel))
    return join(d, 'claude')
  }
  const strip = (r: { events: unknown[]; sessionTitles: unknown }) => ({ events: r.events, sessionTitles: r.sessionTitles })

  test('incremental append parses only new lines and equals a full parse', async () => {
    const root = copyFixtures()
    const src = createTranscriptSource({ claudeRoot: root, codexRoot: join(root, 'none') })
    await src.refresh()
    const f = join(root, '-work-demo-app', `${S1}.jsonl`)
    const line = JSON.stringify({ type: 'user', sessionId: S1, cwd: '/work/demo-app', timestamp: '2025-09-01T11:20:00.000Z', message: { role: 'user', content: 'appended prompt' } })
    appendFileSync(f, line + '\n')
    const r = await src.refresh()
    expect(r.reparsed).toBe(1)
    const full = readClaudeProjects({ root })
    expect(strip(r)).toEqual(strip(full))
    expect(r.events.some((e) => e.summary === 'appended prompt')).toBe(true)
  })

  test('rewrite (same size or shrink) triggers a full re-parse', async () => {
    const root = copyFixtures()
    const src = createTranscriptSource({ claudeRoot: root, codexRoot: join(root, 'none') })
    await src.refresh()
    const f = join(root, '-work-other', '33333333-3333-4333-8333-333333333333.jsonl')
    const text = readFileSync(f, 'utf8').replace('What does this regex do?', 'What does this RegEx do?')
    writeFileSync(f, text) // same length, different bytes before offset
    utimesSync(f, new Date(), new Date(Date.now() + 5_000)) // a real rewrite moves mtime
    const r = await src.refresh()
    expect(strip(r)).toEqual(strip(readClaudeProjects({ root })))
    writeFileSync(f, text.split('\n')[0] + '\n') // shrink
    utimesSync(f, new Date(), new Date(Date.now() + 10_000))
    const r2 = await src.refresh()
    expect(strip(r2)).toEqual(strip(readClaudeProjects({ root })))
  })

  test('per-refresh byte cap continues on the next refresh (partial reads converge)', async () => {
    const root = copyFixtures()
    // cap > longest fixture line (782 B) but < the 7978 B main transcript → several partial refreshes
    const src = createTranscriptSource({ claudeRoot: root, codexRoot: join(root, 'none'), maxBytesPerFile: 1000 })
    let r = await src.refresh()
    expect(r.partial).toBeGreaterThan(0)
    expect(r.warnings.file_partial_read).toBeGreaterThan(0)
    for (let i = 0; i < 50 && r.partial > 0; i++) r = await src.refresh()
    expect(r.partial).toBe(0)
    expect(r.warnings.file_partial_read).toBeUndefined()
    expect(strip(r)).toEqual(strip(readClaudeProjects({ root })))
  })
})

describe('P1 sendSummariesToAssessor', () => {
  const task: AssessorTaskView = {
    id: 'het_x', agent: 'claude-code', project: '/Users/[user]/work/secret-project', title: 'TITLE-SENTINEL', start: 0, end: 60_000,
    stats: { events: 2 }, filesWritten: ['/work/secret-project/src/a.ts', '/work/secret-project/README.md'], signals: ['git_commit']
  }
  const ev: AssessorEvidence[] = [
    { eventId: 'ev_1', ts: 0, role: 'user', toolNames: ['Edit'], filesWritten: ['/work/secret-project/src/a.ts'], signals: [], summary: 'SUMMARY-SENTINEL' }
  ]
  test('default false: only ids/enums/counts/signals/file types reach the prompt', () => {
    expect(DEFAULT_HET_SETTINGS.sendSummariesToAssessor).toBe(false)
    expect(HetSettingsSchema.parse({ ...DEFAULT_HET_SETTINGS }).sendSummariesToAssessor).toBe(false)
    const p = buildAssessorPrompt(task, ev, 6000, DEFAULT_HET_SETTINGS.sendSummariesToAssessor)
    for (const s of ['SUMMARY-SENTINEL', 'TITLE-SENTINEL', 'secret-project', '/work/']) expect(p).not.toContain(s)
    expect(p).toContain('"file_types_written":[".md",".ts"]')
    expect(p).toContain('ev_1')
    expect(p).toContain('git_commit')
  })
  test('opt-in true: redacted summaries and paths included', () => {
    const p = buildAssessorPrompt(task, ev, 6000, true)
    expect(p).toContain('SUMMARY-SENTINEL')
    expect(p).toContain('TITLE-SENTINEL')
  })
})
