import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackupService } from '../../src/main/backup/service'
import { openAuditLog } from '../../src/main/broker/audit'
import { CARD_FORMAT, latestCard, newCardId, signCard, writeCardFile } from '../../src/main/identity/card'
import { buildCardContent } from '../../src/main/identity/card-content'
import { createImportService } from '../../src/main/import/service'
import { createPeerStore } from '../../src/main/peers/store'
import { createWorkflowStore } from '../../src/main/workflows/store'
import { HAVE_UPSTREAM, initRoot, isLoopback, recordConnects, sandboxedBin, tempRoot } from '../connectors/upstream'
import { sources } from '../identity/fixtures'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME } from '../import/helpers'
import { cleanupAll, listFiles, populatedStore } from './helpers'

/**
 * S1-R3-06 acceptance on temp roots with the REAL upstream CLI (no-egress sandbox):
 * import → backup → restore → reopen: no loss, no duplicates, no secrets.
 */

const CLAUDE_REL = '.claude/projects/-work-secret-app/aaaaaaaa-1111-4111-8111-111111111111.jsonl'

/** Secret shapes that must never appear in a backup (fixture transcripts contain fakes of all of them). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['openai-style key', /\bsk-[A-Za-z0-9]{20,}/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_/],
  ['aws key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['aws secret', /wJalrXUtnFEMI/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/],
  ['fixture password', /hunter2hunter2/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/]
]

function scanDir(dir: string, extra: string[]): string[] {
  const problems: string[] = []
  for (const f of listFiles(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${f}: ${name}`)
    for (const s of extra) if (s && text.includes(s)) problems.push(`${f}: exact secret`)
  }
  return problems
}

function runtimeCounts(root: string): { sourceImports: number; blocksWith: (s: string) => number } {
  const db = new DatabaseSync(path.join(root, 'index.db'), { readOnly: true })
  try {
    const sourceImports = (db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n
    const rows = db.prepare('SELECT focus_excerpt AS t FROM timeline_blocks').all() as Array<{ t: string | null }>
    return { sourceImports, blocksWith: (s) => rows.filter((r) => (r.t ?? '').includes(s)).length }
  } finally {
    db.close()
  }
}

describe.skipIf(!HAVE_UPSTREAM)('S1-R3-06 import → backup → restore → reopen (real CLI, temp roots)', () => {
  let rt: string
  let bin: string
  let conn: ReturnType<typeof recordConnects>
  beforeAll(() => {
    conn = recordConnects()
    rt = tempRoot('acc-rt')
    initRoot(rt)
    bin = sandboxedBin(tempRoot('acc-bin'))
  }, 120_000)
  afterAll(() => conn?.restore())
  afterAll(() => cleanupAll()) // B17: prefix-guarded (lens-backup-) removal of helper temp dirs

  it('end to end', { timeout: 300_000 }, async () => {
    // ---- 1. import (real `persome import-data --no-build`) ----
    const home = tempRoot('acc-home')
    fs.cpSync(FIXTURE_HOME, home, { recursive: true })
    const store = populatedStore() // identity + workflow v1/v2 + one peer + placeholders
    const imp = () => createImportService({ storeRoot: store.root, homeDir: () => home, runtimeRoot: () => rt, persomeBin: () => bin })
    let svc = imp()
    await svc.scan()
    const r1 = await svc.commit((await svc.prepare([CLAUDE_KEY, CODEX_KEY], { includeTools: true })).runId)
    expect(r1.importCli?.exitCode).toBe(0)
    expect(r1.importCli?.counts).toEqual({ imported: 2, unchanged: 0, skipped: 0 })

    // The session grows; only the new messages are imported.
    const line = (ts: string, type: 'user' | 'assistant', content: unknown) =>
      JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/work/secret-app', sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', version: '2.0.0', type, uuid: `${type}-${ts}`, timestamp: ts, message: { role: type, content } }) + '\n'
    fs.appendFileSync(path.join(home, CLAUDE_REL), line('2025-10-01T09:05:00.000Z', 'user', 'Follow-up Kestrelmoss: shorten the timeout'))
    fs.appendFileSync(path.join(home, CLAUDE_REL), line('2025-10-01T09:05:10.000Z', 'assistant', [{ type: 'text', text: 'Done Kestrelmoss: 15 minutes.' }]))
    svc = imp() // reopen
    await svc.scan()
    const delta = await svc.prepare([CLAUDE_KEY, CODEX_KEY])
    expect(delta.skippedAlreadyImported).toEqual([CODEX_KEY])
    expect(delta.notes?.map((n) => n.kind)).toEqual(['continued'])
    const r2 = await svc.commit(delta.runId)
    expect(r2.importCli?.counts).toEqual({ imported: 1, unchanged: 0, skipped: 0 })

    let counts = runtimeCounts(rt)
    expect(counts.sourceImports).toBe(3)
    expect(counts.blocksWith('Please fix login')).toBe(1)
    expect(counts.blocksWith('Kestrelmoss')).toBe(1) // question + answer live in the one continuation block
    expect(counts.blocksWith('Kestrelmoss: shorten')).toBe(1)
    expect(counts.blocksWith('sk-ant-api03-FAKE')).toBe(0)
    expect(counts.blocksWith('FUNCTION_OUTPUT_MARKER')).toBe(0)
    expect(counts.blocksWith('命令：`cat README.md`')).toBe(1)

    // Ledger lost (e.g. new store) → identical documents are recognised upstream by their stable key.
    fs.rmSync(svc.paths.ledgerPath)
    svc = imp()
    await svc.scan()
    const again = await svc.prepare([CODEX_KEY], { includeTools: true })
    const r3 = await svc.commit(again.runId)
    expect(r3.importCli?.counts).toEqual({ imported: 0, unchanged: 1, skipped: 0 })
    expect(runtimeCounts(rt).sourceImports).toBe(3)

    // ---- 2. Lens data: a real signed card and a real Access log row ----
    fs.rmSync(store.paths.cardsDir, { recursive: true, force: true })
    const id = store.keys.getPublicIdentity()!
    const card = signCard(
      { format: CARD_FORMAT, version: 1, card_id: newCardId(), issued_at: '2026-11-04T10:00:00.000Z', issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint }, content: buildCardContent(sources(), { displayName: 'Ryl' }) },
      store.keys
    )
    writeCardFile(store.paths, card)
    fs.rmSync(store.paths.auditDb, { force: true })
    const audit = openAuditLog(store.paths.auditDb)
    audit.record({ grantId: 'g', client: 'codex', capability: 'search', argsSha256: 'c'.repeat(64), argsPreview: '{"query":"login"}', itemIds: [], itemCount: 0, responseChars: 3, resultPreview: '[]', outcome: 'ok', httpStatus: 200, errorCode: null, durationMs: 2 })
    audit.close()

    // ---- 3. backup (real `persome model export`, redacted) ----
    const backups = tempRoot('acc-backups')
    const bsvc = () => createBackupService({ storeRoot: store.root, runtimeRoot: () => rt, persomeBin: () => bin, appVersion: () => 'test' })
    const plain = await bsvc().exportTo(backups, { withoutModel: false })
    const withLog = await bsvc().exportTo(backups, { withoutModel: false, includeAccessLog: true })
    expect(plain.modelSnapshot).toBe('included')
    const plainFiles = listFiles(plain.path!)
    expect(plainFiles).toEqual(expect.arrayContaining(['manifest.json', 'model-snapshot.json', `lens/cards/${card.card.card_id}.navaliacard`, 'lens/workflows/rt-weekly-report/v000001.json', 'lens/workflows/rt-weekly-report/v000002.json']))
    expect(plainFiles.some((f) => /access-log|audit|import\/|identity|grants/.test(f))).toBe(false)
    expect(listFiles(withLog.path!)).toContain('lens/access-log.json')
    const snap = JSON.parse(fs.readFileSync(path.join(plain.path!, 'model-snapshot.json'), 'utf8'))
    expect(snap.schema_version).toBe(1)

    // ---- 4. secret scan of both backups ----
    const keyText = fs.readFileSync(store.paths.privateKeyFile, 'utf8')
    for (const b of [plain.path!, withLog.path!]) expect(scanDir(b, [keyText.trim()])).toEqual([])

    // ---- 5. restore into a fresh store (new identity) and reopen ----
    const fresh = populatedStore()
    for (const d of ['workflows', 'peers', 'cards']) fs.rmSync(path.join(fresh.root, d), { recursive: true, force: true })
    const rsvc = () => createBackupService({ storeRoot: fresh.root, runtimeRoot: () => rt, persomeBin: () => bin })
    const rs1 = rsvc()
    const rep = await rs1.restore((await rs1.inspect(plain.path!)).inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 1, restored: 0, failed: 0 }) // unsigned → re-stamped copy
    expect(rep.peers).toMatchObject({ added: 1, failed: 0 })
    expect(rep.cards).toMatchObject({ archived: 1, failed: 0 })
    // reopen: fresh store objects read what was restored
    const wf = createWorkflowStore(fresh.root)
    const [latest] = wf.listLatest()
    expect(wf.versions(latest.id).map((w) => w.version)).toEqual([1, 2])
    expect(createPeerStore({ storeRoot: fresh.root }).list().peers.map((p) => p.fingerprint)).toEqual([store.friend.fingerprint])
    expect(fs.existsSync(path.join(fresh.paths.cardsDir, 'archive', `${card.card.card_id}.navaliacard`))).toBe(true)
    // second restore: no duplicates
    const rs2 = rsvc() // reopened service
    const rep2 = await rs2.restore((await rs2.inspect(withLog.path!)).inspectionId!)
    expect(rep2.workflows).toMatchObject({ imported: 0, duplicates: 1 })
    expect(rep2.peers).toMatchObject({ added: 0 })
    expect(rep2.cards).toMatchObject({ archived: 0, unchanged: 1 })
    expect(rep2.notRestored.join()).toMatch(/Access log/)
    expect(wf.listLatest()).toHaveLength(1)

    // ---- 6. restore into the original store (same identity) → nothing duplicated, card still mine ----
    const bs = bsvc()
    const same = await bs.restore((await bs.inspect(plain.path!)).inspectionId!)
    expect(same.workflows).toMatchObject({ imported: 0, duplicates: 1 })
    expect(same.cards).toMatchObject({ restored: 0, unchanged: 1 })
    expect(latestCard(store.paths)?.card.card_id).toBe(card.card.card_id)
    expect(createWorkflowStore(store.root).listLatest()).toHaveLength(1)

    // Runtime untouched by backup / restore.
    counts = runtimeCounts(rt)
    expect(counts.sourceImports).toBe(3)
    expect(counts.blocksWith('Please fix login')).toBe(1)

    expect(conn.hosts.filter((h) => !isLoopback(h))).toEqual([])
    console.log('[S1-R3-06] receipts', JSON.stringify({ first: r1.importCli?.counts, delta: r2.importCli?.counts, ledgerLost: r3.importCli?.counts, sourceImports: counts.sourceImports }))
  })
})
