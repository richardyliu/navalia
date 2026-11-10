// S1-R4-06 (DECISIONS-ROUND3 X8) + S1-R4-10: backup may include the Access log only on explicit
// opt-in; the manifest says `includes_access_log: true/false`; the private key and grants.json are
// never in a backup either way; restore handles both kinds; cards/ and Workflow history round-trip.
// Every store / target is a mkdtemp dir; the `persome` CLI is a test double.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { BACKUP_FORMAT_VERSION, MODEL_SNAPSHOT_NOTE } from '../../src/main/backup/api'
import { ACCESS_LOG_FILE, createBackupService, ManifestSchema } from '../../src/main/backup/service'
import { openAuditLog } from '../../src/main/broker/audit'
import { restoreLines } from '../../src/renderer/src/components/backup/backupView'
import { cleanupAll, fakePersome, listFiles, populatedStore, runtimeRoot, tempDir } from './helpers'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

afterEach(cleanupAll)

const svc = (storeRoot: string) =>
  createBackupService({ storeRoot, runtimeRoot: runtimeRoot, persomeBin: () => fakePersome(), now: () => Date.UTC(2026, 10, 5, 9, 30, 0), appVersion: () => '0.1.0' })

function rec(i: number) {
  return {
    grantId: 'g1',
    client: 'claude-code',
    capability: 'search',
    argsSha256: String(i % 10).repeat(64),
    argsPreview: `{"query":"q${i}"}`,
    itemIds: [`e${i}`],
    itemCount: 1,
    responseChars: 10,
    resultPreview: `result ${i}`,
    outcome: 'ok' as const,
    httpStatus: 200,
    errorCode: null,
    durationMs: 1
  }
}

/** populatedStore + a real audit.db with `n` rows; the writer connection is returned OPEN. */
function storeWithAudit(n: number) {
  const s = populatedStore()
  fs.rmSync(s.paths.auditDb, { force: true })
  const audit = openAuditLog(s.paths.auditDb)
  for (let i = 0; i < n; i++) audit.record(rec(i))
  return { ...s, audit }
}

const manifestOf = (dir: string) => ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')))
const allBytes = (dir: string) => Buffer.concat(listFiles(dir).map((f) => fs.readFileSync(path.join(dir, f))))

describe('X8 Access log opt-in', () => {
  it('manifest records includes_access_log false / true; key and grants are never included either way', async () => {
    const s = storeWithAudit(3)
    try {
      const key = fs.readFileSync(s.paths.privateKeyFile)
      const grants = fs.readFileSync(s.paths.grantsFile)
      for (const includeAccessLog of [false, true]) {
        const r = await svc(s.root).exportTo(tempDir('target'), { withoutModel: false, includeAccessLog })
        const m = manifestOf(r.path!)
        expect(m.format_version).toBe(BACKUP_FORMAT_VERSION)
        expect(m.includes_access_log).toBe(includeAccessLog)
        expect(m.access_log?.status).toBe(includeAccessLog ? 'included' : 'not_requested')
        const files = listFiles(r.path!)
        expect(files.includes(ACCESS_LOG_FILE)).toBe(includeAccessLog)
        expect(files.filter((f) => /identity|ed25519|\.key\.enc|grants|audit\.db|het\.db/.test(f))).toEqual([])
        const bytes = allBytes(r.path!)
        expect(bytes.includes(key)).toBe(false)
        expect(bytes.includes(grants)).toBe(false)
        expect(bytes.includes(Buffer.from('deadbeef'))).toBe(false) // grant token hash from the fixture
        expect(m.excluded.map((e) => e.path)).toEqual(expect.arrayContaining(['identity/', 'grants.json']))
        expect(m.notes).toContain(MODEL_SNAPSHOT_NOTE)
      }
    } finally {
      s.audit.close()
    }
  })

  it('consistent copy: every committed row is exported while the Broker connection stays open; no sqlite file copied', async () => {
    const s = storeWithAudit(25)
    try {
      const r = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true, includeAccessLog: true })
      const doc = JSON.parse(fs.readFileSync(path.join(r.path!, ACCESS_LOG_FILE), 'utf8'))
      expect(doc.rows).toHaveLength(25)
      expect(doc.rows.map((x: { id: number }) => x.id)).toEqual([...Array(25).keys()].map((i) => i + 1))
      expect(r.accessLogRows).toBe(25)
      expect(listFiles(r.path!).some((f) => /\.db|journal|wal|shm/.test(f))).toBe(false)
      // The live Access log still works after the export (the read transaction was closed).
      s.audit.record(rec(99))
    } finally {
      s.audit.close()
    }
  })

  it('restore handles both: without → accessLog.included false; with → archived only, local audit.db untouched', async () => {
    const s = storeWithAudit(2)
    s.audit.close()
    const without = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true })
    const withLog = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true, includeAccessLog: true })

    const fresh = populatedStore()
    const auditBefore = fs.readFileSync(fresh.paths.auditDb)
    const grantsBefore = fs.readFileSync(fresh.paths.grantsFile)
    const keyBefore = fs.readFileSync(fresh.paths.privateKeyFile)
    const service = svc(fresh.root)

    const i1 = await service.inspect(without.path!)
    expect(i1.accessLog).toBe(false)
    const r1 = await service.restore(i1.inspectionId!)
    expect(r1.accessLog).toEqual({ included: false, rows: null })
    expect(r1.notRestored.join()).not.toMatch(/Access log/)
    expect(restoreLines(r1)).toContain('Access log：这份备份不含 Access log')

    const i2 = await service.inspect(withLog.path!)
    expect(i2.accessLog).toBe(true)
    const r2 = await service.restore(i2.inspectionId!)
    expect(r2.accessLog).toEqual({ included: true, rows: 2 })
    expect(r2.notRestored.join()).toMatch(/Access log（仅存档/)
    expect(restoreLines(r2).join('\n')).toMatch(/备份中含 2 条记录，仅存档/)

    expect(fs.readFileSync(fresh.paths.auditDb).equals(auditBefore)).toBe(true)
    expect(fs.readFileSync(fresh.paths.grantsFile).equals(grantsBefore)).toBe(true)
    expect(fs.readFileSync(fresh.paths.privateKeyFile).equals(keyBefore)).toBe(true)
  })

  it('a manifest whose includes_access_log disagrees with its files is refused before anything is written', async () => {
    const s = storeWithAudit(1)
    s.audit.close()
    const b = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true, includeAccessLog: true })
    const mp = path.join(b.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
    // Drop the Access log file + its manifest entry but keep the flag: inconsistent.
    fs.rmSync(path.join(b.path!, ACCESS_LOG_FILE))
    m.files = m.files.filter((f: { path: string }) => f.path !== ACCESS_LOG_FILE)
    fs.writeFileSync(mp, JSON.stringify(m))
    const fresh = tempDir('fresh')
    await expect(svc(fresh).inspect(b.path!)).rejects.toThrow(/includes_access_log=true 与备份内容不一致/)
    // Flag flipped to false while access_log.status still says included: also refused.
    m.includes_access_log = false
    fs.writeFileSync(mp, JSON.stringify(m))
    await expect(svc(fresh).inspect(b.path!)).rejects.toThrow(/access_log 状态与备份内容不一致/)
    expect(fs.readdirSync(fresh)).toEqual([])
  })

  it('a v2 backup (no includes_access_log field) is still accepted; the flag is derived from the files', async () => {
    const s = storeWithAudit(1)
    s.audit.close()
    const b = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true, includeAccessLog: true })
    const mp = path.join(b.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
    m.format_version = 2
    delete m.includes_access_log
    fs.writeFileSync(mp, JSON.stringify(m))
    const fresh = populatedStore()
    const service = svc(fresh.root)
    const info = await service.inspect(b.path!)
    expect(info.accessLog).toBe(true)
    expect((await service.restore(info.inspectionId!)).accessLog).toEqual({ included: true, rows: 1 })
  })
})

describe('S1-R4-10: cards/ and Workflow history are in every backup and come back', () => {
  it('backup lists lens/cards/*.navaliacard and every Workflow version file; restore keeps v1 + v2', async () => {
    const s = populatedStore()
    const b = await svc(s.root).exportTo(tempDir('target'), { withoutModel: true })
    const files = listFiles(b.path!)
    expect(files).toContain('lens/cards/card_0123456789abcdef0123456789abcdef.navaliacard')
    const versions = files.filter((f) => /^lens\/workflows\/[^/]+\/v\d{6}\.json$/.test(f))
    expect(versions.map((f) => path.basename(f))).toEqual(['v000001.json', 'v000002.json'])
    const m = manifestOf(b.path!)
    for (const f of versions) {
      const e = m.files.find((x) => x.path === f)!
      expect(e.sha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(b.path!, f))).digest('hex'))
    }
    const fresh = tempDir('fresh')
    const service = svc(fresh)
    const info = await service.inspect(b.path!)
    expect(info.counts).toMatchObject({ workflows: 1, workflowVersions: 2, cards: 1 })
    const rep = await service.restore(info.inspectionId!)
    expect(rep.workflows.items).toEqual([expect.objectContaining({ outcome: 'imported', versions: 2 })])
    expect(restoreLines(rep).join('\n')).toMatch(/Workflow 版本历史：共恢复 2 个版本/)
  })

  it('the model snapshot is stated (UI + manifest) to be a redacted export, not the Runtime DB / captures', () => {
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/不是 Runtime 原始数据库（index\.db）/)
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/不含截图、采集帧或 capture-buffer/)
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/另外备份 Runtime 数据目录本身/)
  })
})

describe('en: English UI text', () => {
  it('en: restore lines describe the Access log in English', () => {
    setLocale('en')
    const lines = restoreLines({
      name: 'x',
      workflows: { imported: 0, duplicates: 0, failed: 0, items: [] },
      peers: { added: 0, updated: 0, unchanged: 0, failed: 0, items: [] },
      accessLog: { included: false, rows: null },
      notRestored: []
    })
    expect(lines).toContain('Access log: this backup does not contain the Access log')
  })
})
