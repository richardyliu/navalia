import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { ACCESS_LOG_WARNING, MODEL_SNAPSHOT_NOTE } from '../../src/main/backup/api'
import { ACCESS_LOG_FILE, createBackupService, ManifestSchema } from '../../src/main/backup/service'
import { openAuditLog } from '../../src/main/broker/audit'
import { CARD_FORMAT, latestCard, newCardId, signCard, writeCardFile } from '../../src/main/identity/card'
import { buildCardContent } from '../../src/main/identity/card-content'
import type { KeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { createWorkflowStore } from '../../src/main/workflows/store'
import { sources } from '../identity/fixtures'
import { cleanupAll, fakePersome, listFiles, populatedStore, RUNTIME_TOKEN, runtimeRoot, tempDir } from './helpers'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

/** S1-R3-06 backup integrity: cards restore, Workflow history, Access log opt-in (X8), redaction note. */

afterEach(cleanupAll)

function service(storeRoot: string, rt = runtimeRoot()) {
  return createBackupService({
    storeRoot,
    runtimeRoot: () => rt,
    persomeBin: () => fakePersome(),
    now: () => Date.UTC(2026, 10, 5, 9, 30, 0),
    appVersion: () => '0.1.0'
  })
}

function issueCard(keys: KeyManager, root: string, issuedAt: string): string {
  const id = keys.getPublicIdentity()!
  const signed = signCard(
    {
      format: CARD_FORMAT,
      version: 1,
      card_id: newCardId(),
      issued_at: issuedAt,
      issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
      content: buildCardContent(sources(), { displayName: 'Ryl' })
    },
    keys
  )
  writeCardFile(storePaths(root), signed)
  return signed.card.card_id
}

/** A store with real signed cards and a real audit.db (the shared fixture writes placeholders). */
function richStore() {
  const s = populatedStore()
  fs.rmSync(s.paths.cardsDir, { recursive: true, force: true })
  const cardId = issueCard(s.keys, s.root, '2026-11-04T10:00:00.000Z')
  fs.rmSync(s.paths.auditDb, { force: true })
  const audit = openAuditLog(s.paths.auditDb)
  audit.record({
    grantId: 'g1',
    client: 'claude-code',
    capability: 'search',
    argsSha256: 'a'.repeat(64),
    argsPreview: '{"query":"周报"}',
    itemIds: ['e1'],
    itemCount: 1,
    responseChars: 42,
    resultPreview: '周报 17:00 前发出',
    outcome: 'ok',
    httpStatus: 200,
    errorCode: null,
    durationMs: 5
  })
  audit.close()
  return { ...s, cardId }
}

describe('backup manifest and Access log (X8)', () => {
  it('default: no Access log, audit.db listed as excluded, redaction note in the manifest', async () => {
    const s = richStore()
    const r = await service(s.root).exportTo(tempDir('target'), { withoutModel: false })
    expect(listFiles(r.path!)).not.toContain(ACCESS_LOG_FILE)
    const m = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(r.path!, 'manifest.json'), 'utf8')))
    expect(m.format_version).toBe(4)
    expect(m.includes_user_data).toEqual({ chat: false, meetings: false, moments: false })
    expect(m.includes_access_log).toBe(false)
    expect(m.notes).toContain(MODEL_SNAPSHOT_NOTE)
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/脱敏/)
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/不是 Runtime 原始数据库/)
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/截图/)
    expect(m.access_log).toEqual({ status: 'not_requested', rows: null, warning: null })
    expect(m.excluded.map((e) => e.path)).toContain('audit.db')
    expect(r.accessLogRows).toBeNull()
  })

  it('opt-in: rows exported as JSON with the warning; the sqlite file itself is never copied', async () => {
    const s = richStore()
    const r = await service(s.root).exportTo(tempDir('target'), { withoutModel: true, includeAccessLog: true })
    const files = listFiles(r.path!)
    expect(files).toContain(ACCESS_LOG_FILE)
    expect(files.some((f) => /audit\.db/.test(f))).toBe(false)
    const doc = JSON.parse(fs.readFileSync(path.join(r.path!, ACCESS_LOG_FILE), 'utf8'))
    expect(doc.rows).toHaveLength(1)
    expect(doc.rows[0]).toMatchObject({ client: 'claude-code', capability: 'search' })
    expect(doc.warning).toBe(ACCESS_LOG_WARNING)
    const m = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(r.path!, 'manifest.json'), 'utf8')))
    expect(m.access_log).toEqual({ status: 'included', rows: 1, warning: ACCESS_LOG_WARNING })
    expect(m.excluded.map((e) => e.path)).not.toContain('audit.db')
    expect(r.accessLogRows).toBe(1)
  })

  it('opt-in Access log is still secret-scanned: a Runtime token inside a preview aborts the export', async () => {
    const s = richStore()
    const audit = openAuditLog(s.paths.auditDb)
    audit.record({
      grantId: null,
      client: 'x',
      capability: 'search',
      argsSha256: 'b'.repeat(64),
      argsPreview: `token ${RUNTIME_TOKEN}`,
      itemIds: [],
      itemCount: 0,
      responseChars: 0,
      resultPreview: '',
      outcome: 'ok',
      httpStatus: 200,
      errorCode: null,
      durationMs: 1
    })
    audit.close()
    const parent = tempDir('target')
    await expect(service(s.root).exportTo(parent, { withoutModel: true, includeAccessLog: true })).rejects.toThrow(/疑似密钥/)
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('a v1 backup (before S1-R3-06) is still accepted', async () => {
    const s = richStore()
    const r = await service(s.root).exportTo(tempDir('target'), { withoutModel: true })
    const p = path.join(r.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    m.format_version = 1
    delete m.notes
    delete m.access_log
    fs.writeFileSync(p, JSON.stringify(m))
    const info = await service(tempDir('fresh')).inspect(r.path!)
    expect(info.accessLog).toBe(false)
  })
})

describe('restore keeps cards and Workflow history', () => {
  it('fresh machine (new identity, unsigned backup): Workflow v1+v2 restored under one new id; cards archived, not served as mine', async () => {
    const s = richStore()
    const backup = await service(s.root).exportTo(tempDir('target'), { withoutModel: false, includeAccessLog: true })

    // New machine: populated store with its own identity, data removed.
    const fresh = populatedStore()
    for (const d of ['workflows', 'peers', 'cards']) fs.rmSync(path.join(fresh.root, d), { recursive: true, force: true })
    const svc = service(fresh.root)
    const info = await svc.inspect(backup.path!)
    expect(info.counts).toMatchObject({ workflows: 1, workflowVersions: 2, cards: 1 })
    expect(info.accessLog).toBe(true)
    expect(info.notes).toContain(MODEL_SNAPSHOT_NOTE)
    const rep = await svc.restore(info.inspectionId!)

    expect(rep.workflows.items).toEqual([expect.objectContaining({ outcome: 'imported', versions: 2 })])
    const store = createWorkflowStore(fresh.root)
    const [latest] = store.listLatest()
    const history = store.versions(latest.id)
    expect(history.map((w) => w.version)).toEqual([1, 2])
    expect(history[0].title).not.toBe('周报（我的版本）')
    expect(history[1].title).toBe('周报（我的版本）')
    expect(history.every((w) => w.id === latest.id && w.id.startsWith('imp-'))).toBe(true)
    expect(latest.provenance).toMatchObject({ kind: 'imported', original_id: s.workflowId, original_version: 2 })
    // The history is editable: the next edit becomes v3.
    const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = latest
    const edited = store.saveEdit(latest.id, 2, { title: `${title}!`, goal, context, inputs, tools, steps, artifacts, rules, problems, tags }, null)
    expect(edited.workflow.version).toBe(3)

    expect(rep.cards).toMatchObject({ restored: 0, archived: 1, failed: 0 })
    expect(fs.existsSync(path.join(fresh.paths.cardsDir, 'archive', `${s.cardId}.navaliacard`))).toBe(true)
    expect(latestCard(fresh.paths)).toBeNull()
    expect(rep.notRestored.join('\n')).toMatch(/Access log/)
    expect(rep.notRestored.join('\n')).toMatch(/模型快照/)
    expect(fs.readFileSync(fresh.paths.auditDb, 'utf8')).toBe('SQLite format 3\u0000audit') // untouched

    // Restoring again: no duplicates anywhere.
    const again = await svc.restore((await svc.inspect(backup.path!)).inspectionId!)
    // Unsigned → copy path; its content (v2) already exists in the imp-* history → duplicate.
    expect(again.workflows).toMatchObject({ imported: 0, duplicates: 1 })
    expect(again.cards).toMatchObject({ restored: 0, archived: 0, unchanged: 1 })
    expect(store.listLatest()).toHaveLength(1)
  })

  it('same identity: a deleted card comes back into cards/ and is the latest card again', async () => {
    const s = richStore()
    const backup = await service(s.root).exportTo(tempDir('target'), { withoutModel: true })
    fs.rmSync(s.paths.cardsDir, { recursive: true, force: true })
    expect(latestCard(s.paths)).toBeNull()
    const svc = service(s.root)
    const rep = await svc.restore((await svc.inspect(backup.path!)).inspectionId!)
    expect(rep.cards).toMatchObject({ restored: 1, archived: 0, failed: 0 })
    expect(latestCard(s.paths)?.card.card_id).toBe(s.cardId)
  })

  it('a tampered card (valid manifest hash, bad signature) is reported failed and not written', async () => {
    const s = richStore()
    const backup = await service(s.root).exportTo(tempDir('target'), { withoutModel: true })
    const rel = listFiles(backup.path!).find((f) => f.startsWith('lens/cards/'))!
    const file = path.join(backup.path!, rel)
    const card = JSON.parse(fs.readFileSync(file, 'utf8'))
    card.card.content.headline = 'forged'
    const buf = Buffer.from(JSON.stringify(card))
    fs.writeFileSync(file, buf)
    const mp = path.join(backup.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
    const entry = m.files.find((f: { path: string }) => f.path === rel)
    entry.bytes = buf.length
    entry.sha256 = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex')
    fs.writeFileSync(mp, JSON.stringify(m))
    const fresh = tempDir('fresh')
    const svc = service(fresh)
    const rep = await svc.restore((await svc.inspect(backup.path!)).inspectionId!)
    expect(rep.cards).toMatchObject({ restored: 0, archived: 0, failed: 1 })
    expect(fs.existsSync(path.join(fresh, 'cards'))).toBe(false)
  })
})

import { accessLogWarningText, modelSnapshotNoteText } from '../../src/main/backup/api'

describe('en: English UI text', () => {
  it('en: manifest notes stay Chinese on disk; Settings shows the English text', () => {
    setLocale('en')
    expect(MODEL_SNAPSHOT_NOTE).toMatch(/不是 Runtime 原始数据库/)
    expect(modelSnapshotNoteText()).toMatch(/not the Runtime raw database/)
    expect(accessLogWarningText()).toMatch(/never contains the identity private key/)
    setLocale('zh')
    expect(modelSnapshotNoteText()).toBe(MODEL_SNAPSHOT_NOTE)
    expect(accessLogWarningText()).toBe(ACCESS_LOG_WARNING)
  })
})
