import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecFn } from '../../src/main/import/cli'
import { dedupeKey, renderSession, scrubLocalPaths, sessionKey } from '../../src/main/import/markdown'
import { createImportService } from '../../src/main/import/service'
import { loadSession, scanTranscripts, type TranscriptSession } from '../../src/main/import/transcripts'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME } from './helpers'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

/** C20 — import integrity: tool calls kept (redacted), local paths scrubbed, stable dedupe keys, re-import = unchanged. */

const TMP = realpathSync(tmpdir())
const made: string[] = []
function tmp(label: string): string {
  const d = mkdtempSync(join(TMP, `lens-ib-${label}-`))
  made.push(d)
  return d
}
afterAll(() => {
  // Only delete what this file created: mkdtemp dirs directly under tmpdir with our prefix.
  for (const d of made.splice(0)) {
    if (basename(d).startsWith('lens-ib-') && dirname(d) === TMP) rmSync(d, { recursive: true, force: true })
  }
})

function walk(root: string): string[] {
  const out: string[] = []
  const rec = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) rec(p)
      else out.push(relative(root, p).split('\\').join('/'))
    }
  }
  rec(root)
  return out
}

/**
 * Emulates `persome import-data --source folder` keying (personal-model src/persome/source_import.py
 * `import_folder`): source_key = sha256("folder\0<resolved root>\0<relative>"), unchanged when the
 * stored content sha256 matches. Persists across calls like the Runtime's `source_imports` table.
 */
function upstreamEmulator() {
  const table = new Map<string, string>()
  const calls: Array<{ imported: number; unchanged: number }> = []
  const exec: ExecFn = async (_bin, args) => {
    const root = realpathSync(args[args.indexOf('--path') + 1])
    let imported = 0
    let unchanged = 0
    for (const rel of walk(root).filter((f) => f.endsWith('.md'))) {
      const data = readFileSync(join(root, rel))
      const key = createHash('sha256').update(`folder\0${root}\0${rel}`).digest('hex')
      const digest = createHash('sha256').update(data).digest('hex')
      if (table.get(key) === digest) unchanged++
      else {
        table.set(key, digest)
        imported++
      }
    }
    calls.push({ imported, unchanged })
    return { code: 0, signal: null, stdout: `✓ Imported ${imported} new/changed document(s); ${unchanged} unchanged, 0 skipped.\n`, stderr: '' }
  }
  return { exec, table, calls }
}

const session = (over: Partial<TranscriptSession> = {}): TranscriptSession => ({
  key: 'claude-code:s-1',
  source: 'claude-code',
  sessionId: 's-1',
  project: '/Users/alice/work/app',
  title: 'Fix build',
  files: [],
  startTs: Date.UTC(2026, 0, 1),
  endTs: Date.UTC(2026, 0, 1, 1),
  messages: [
    { role: 'user', ts: Date.UTC(2026, 0, 1), text: 'Build fails in /Users/alice/work/app, see /Users/alice/.persome/logs/daemon.log', tools: [] },
    {
      role: 'assistant',
      ts: Date.UTC(2026, 0, 1, 0, 1),
      text: 'Fixed. Mail bob@example.com if it breaks again.',
      tools: ['Bash', 'Write', 'Edit'],
      toolCalls: [
        { name: 'Bash', command: 'cd /Users/alice/work/app && OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUV npm test', paths: [] },
        { name: 'Write', command: null, paths: ['/Users/alice/work/app/src/a.ts'] },
        { name: 'Edit', command: null, paths: ['/Users/alice/.persome/config.toml', '/Users/alice/Library/Application Support/Navalia/grants.json'] }
      ]
    }
  ],
  ...over
})
const HOME = '/Users/alice'
const RT = '/Users/alice/.persome'
const STORE = '/Users/alice/Library/Application Support/Navalia'

describe('C20 rendering: tool calls kept, paths scrubbed, front matter keys', () => {
  it('keeps tool names, commands and artifact paths by default; redacts secrets / emails; home → ~; Runtime + Lens paths removed', () => {
    const md = renderSession(session(), HOME, { runtimeRoot: RT, storeRoot: STORE }).documents[0].content
    expect(md).toContain('- 工具调用摘要：已包含')
    expect(md).toContain('- 工具：Bash · 命令：`cd ~/work/app && OPENAI_API_KEY: [redacted] npm test`')
    expect(md).toContain('- 工具：Write · 路径：~/work/app/src/a.ts')
    expect(md).toContain('- 工具：Edit · 路径：[persome-runtime]')
    expect(md).toContain('Build fails in ~/work/app, see [persome-runtime]')
    expect(md).toContain('- 项目：~/work/app')
    for (const leak of ['/Users/alice', 'sk-proj-', 'bob@example.com', '.persome', 'daemon.log', 'config.toml', 'grants.json', 'Navalia/']) {
      expect(md).not.toContain(leak)
    }
  })

  it('scrubLocalPaths: longest root first, boundaries respected, ~ forms matched', () => {
    expect(scrubLocalPaths('x ~/.persome/env y', HOME, { runtimeRoot: RT })).toBe('x [persome-runtime] y')
    expect(scrubLocalPaths('"/Users/alice/.persome"', HOME, { runtimeRoot: RT })).toBe('"[persome-runtime]"')
    expect(scrubLocalPaths('/Users/alice/.persomeX/a', HOME, { runtimeRoot: RT })).toBe('~/.persomeX/a')
    expect(scrubLocalPaths('/Users/alicebob/a and /Users/alice', HOME)).toBe('/Users/alicebob/a and ~')
  })

  it('deterministic: same input → identical bytes; front matter carries session_key / dedupe_key / turns', () => {
    const a = renderSession(session(), HOME, { runtimeRoot: RT })
    const b = renderSession(session(), HOME, { runtimeRoot: RT })
    expect(a.documents).toEqual(b.documents)
    const d = a.documents[0]
    expect(d.content.startsWith('---\nlens_import: 1\nsource: claude-code\n')).toBe(true)
    expect(d.content).toContain(`session_key: ${sessionKey('claude-code', 's-1')}`)
    expect(d.content).toContain(`dedupe_key: ${d.dedupeKey}`)
    expect(d.content).toContain('turns: 1-2\npart: 1/1\n---\n')
    expect(d.turns).toEqual([1, 2])
  })

  it('dedupe key ignores render options and home dir, but changes with content, turn range or session', () => {
    const base = renderSession(session(), HOME).documents[0].dedupeKey
    expect(renderSession(session(), HOME, { includeTools: false }).documents[0].dedupeKey).toBe(base)
    expect(renderSession(session(), '/Users/other', { runtimeRoot: '/tmp/rt' }).documents[0].dedupeKey).toBe(base)
    // Whitespace-only differences (CRLF / trailing spaces) normalise to the same key.
    const ws = session()
    ws.messages[1] = { ...ws.messages[1], text: `${ws.messages[1].text}  \r\n` }
    expect(renderSession(ws, HOME).documents[0].dedupeKey).toBe(base)
    const changed = session()
    changed.messages[1] = { ...changed.messages[1], text: 'Different answer' }
    expect(renderSession(changed, HOME).documents[0].dedupeKey).not.toBe(base)
    expect(renderSession(session({ sessionId: 's-2', key: 'claude-code:s-2' }), HOME).documents[0].dedupeKey).not.toBe(base)
    const tail = renderSession(session(), HOME, { from: 1 }).documents[0]
    expect(tail.turns).toEqual([2, 2])
    expect(tail.dedupeKey).toBe(dedupeKey('claude-code', 's-1', 2, 2, session().messages.slice(1)))
  })

  it('split sessions: each part has its own turn range and key', () => {
    const big = 'y '.repeat(300_000)
    const s = session({ messages: Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, ts: i, text: `${i} ${big}`, tools: [] })) })
    const docs = renderSession(s, HOME).documents
    expect(docs.length).toBeGreaterThan(1)
    expect(docs[0].turns[0]).toBe(1)
    expect(docs[docs.length - 1].turns[1]).toBe(6)
    for (let i = 1; i < docs.length; i++) expect(docs[i].turns[0]).toBe(docs[i - 1].turns[1] + 1)
    expect(new Set(docs.map((d) => d.dedupeKey)).size).toBe(docs.length)
  })
})

describe('C20 transcript extraction: Codex exec_command / function arg paths', () => {
  it('reads `cmd` (unified exec) and `path` arguments; never the output', async () => {
    const home = tmp('home')
    const id = 'cccccccc-3333-4333-8333-333333333333'
    const dir = join(home, '.codex', 'sessions', '2026', '01', '02')
    mkdirSync(dir, { recursive: true })
    const line = (ts: string, payload: unknown, type = 'response_item'): string => JSON.stringify({ timestamp: ts, type, payload })
    writeFileSync(
      join(dir, `rollout-2026-01-02T08-00-00-${id}.jsonl`),
      [
        line('2026-01-02T08:00:00.000Z', { id, cwd: join(home, 'proj') }, 'session_meta'),
        line('2026-01-02T08:00:01.000Z', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests' }] }),
        line('2026-01-02T08:00:02.000Z', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -- --run', workdir: join(home, 'proj') }), call_id: 'a' }),
        line('2026-01-02T08:00:03.000Z', { type: 'function_call_output', call_id: 'a', output: 'OUTPUT_MARKER_C20' }),
        line('2026-01-02T08:00:04.000Z', { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: join(home, 'proj', 'shot.png') }), call_id: 'b' }),
        line('2026-01-02T08:00:05.000Z', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All green.' }] })
      ].join('\n') + '\n'
    )
    const scan = await scanTranscripts(home)
    const key = `codex:${id}`
    const s = (await loadSession(key, scan.sessions.find((x) => x.key === key)!.files))!
    const md = renderSession(s, home).documents[0].content
    expect(md).toContain('- 工具：exec_command · 命令：`npm test -- --run`')
    expect(md).toContain('- 工具：view_image · 路径：~/proj/shot.png')
    expect(md).not.toContain('OUTPUT_MARKER_C20')
    expect(md).not.toContain(home)
  })
})

describe('C20 re-import: stable path + stable bytes → upstream reports unchanged', () => {
  function svcWith(home: string, storeRoot: string, exec: ExecFn) {
    const runtimeRoot = tmp('rt')
    return createImportService({ storeRoot, runtimeRoot: () => runtimeRoot, homeDir: () => home, persomeBin: () => '/opt/fake/persome', exec })
  }

  it('import twice (ledger lost in between) → second run: 0 new, all unchanged', async () => {
    const up = upstreamEmulator()
    const storeRoot = tmp('store')
    const svc = svcWith(FIXTURE_HOME, storeRoot, up.exec)
    await svc.scan()
    const r1 = await svc.commit((await svc.prepare([CLAUDE_KEY, CODEX_KEY])).runId)
    expect(r1.importCli?.counts).toEqual({ imported: 2, unchanged: 0, skipped: 0 })
    expect(r1.documents.every((d) => /^[0-9a-f]{64}$/.test(d.dedupeKey ?? ''))).toBe(true)

    // Simulate a fresh Lens (or a wiped ledger): Lens no longer remembers the import.
    rmSync(svc.paths.ledgerPath)
    const svc2 = svcWith(FIXTURE_HOME, storeRoot, up.exec)
    await svc2.scan()
    const r2 = await svc2.commit((await svc2.prepare([CLAUDE_KEY, CODEX_KEY])).runId)
    expect(r2.importCli?.counts).toEqual({ imported: 0, unchanged: 2, skipped: 0 })
    expect(up.table.size).toBe(2)
    expect(r2.documents.map((d) => d.dedupeKey)).toEqual(r1.documents.map((d) => d.dedupeKey))
  })

  it('with the ledger: re-selecting the same sessions stages nothing and never calls the CLI; a tool-summary toggle is not a new document', async () => {
    const up = upstreamEmulator()
    const svc = svcWith(FIXTURE_HOME, tmp('store'), up.exec)
    await svc.scan()
    await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    await svc.scan()
    const again = await svc.prepare([CODEX_KEY], { includeTools: false })
    expect(again.documents).toEqual([])
    expect(again.skippedAlreadyImported).toEqual([CODEX_KEY])
    await expect(svc.commit(again.runId)).rejects.toThrow(/没有需要导入的文档/)
    expect(up.calls).toHaveLength(1)
  })

  it('a whitespace-only rewrite of an imported session matches the stored dedupe key → nothing staged (no duplicate upstream)', async () => {
    const home = tmp('home')
    cpSync(FIXTURE_HOME, home, { recursive: true })
    const up = upstreamEmulator()
    const svc = svcWith(home, tmp('store'), up.exec)
    await svc.scan()
    await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    const file = join(home, '.codex/sessions/2025/10/02/rollout-2025-10-02T08-00-00-bbbbbbbb-2222-4222-8222-222222222222.jsonl')
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, before.replace('Add a README section about setup.', 'Add a README section about setup.   '))
    await svc.scan()
    const again = await svc.prepare([CODEX_KEY])
    expect(again.documents).toEqual([])
    expect(again.skippedAlreadyImported).toEqual([CODEX_KEY])
    // The ledger's exact prefix hash no longer matches (so this is the rewrite path) — the dedupe key saved it.
    expect(again.notes?.map((n) => n.kind)).toEqual(['rewritten'])
    expect(up.calls).toHaveLength(1)
  })

  it('a grown session stages only the new turns, under a new stable name; the first document stays unchanged upstream', async () => {
    const home = tmp('home')
    cpSync(FIXTURE_HOME, home, { recursive: true })
    const up = upstreamEmulator()
    const svc = svcWith(home, tmp('store'), up.exec)
    await svc.scan()
    const first = await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    const file = join(home, '.codex/sessions/2025/10/02/rollout-2025-10-02T08-00-00-bbbbbbbb-2222-4222-8222-222222222222.jsonl')
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        JSON.stringify({ timestamp: '2025-10-02T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'One more thing.' }] } }) +
        '\n'
    )
    await svc.scan()
    const next = await svc.prepare([CODEX_KEY])
    expect(next.documents).toHaveLength(1)
    expect(next.documents[0].file).toMatch(/\.from-\d+\.md$/)
    expect(next.documents[0].dedupeKey).not.toBe(first.documents[0].dedupeKey)
    const r = await svc.commit(next.runId)
    expect(r.importCli?.counts).toEqual({ imported: 1, unchanged: 0, skipped: 0 })
    expect(up.table.size).toBe(2)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('an already-imported batch reports in English', async () => {
    const up = upstreamEmulator()
    const runtimeRoot = tmp('rt')
    const svc = createImportService({ storeRoot: tmp('store'), runtimeRoot: () => runtimeRoot, homeDir: () => FIXTURE_HOME, persomeBin: () => '/opt/fake/persome', exec: up.exec })
    await svc.scan()
    await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    await svc.scan()
    const again = await svc.prepare([CODEX_KEY])
    await expect(svc.commit(again.runId)).rejects.toThrow(/no documents to import/)
  })
})
