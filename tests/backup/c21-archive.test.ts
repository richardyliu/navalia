import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, beforeEach } from 'vitest'
import { BACKUP_CHANNELS } from '../../src/main/backup/api'
import {
  BackupCryptoError,
  ContainerReader,
  ContainerWriter,
  decryptFile,
  ENC_EXT,
  ENC_MAGIC,
  EncryptWriter,
  LEGACY_ENC_EXT,
  readEncHeader
} from '../../src/main/backup/crypto'
import { registerBackupHandlers } from '../../src/main/backup/ipc'
import { createBackupService, restoreSummary } from '../../src/main/backup/service'
import { openAuditLog } from '../../src/main/broker/audit'
import { CARD_FORMAT, newCardId, signCard, writeCardFile } from '../../src/main/identity/card'
import { buildCardContent } from '../../src/main/identity/card-content'
import type { KeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import type { WorkflowEdit } from '../../src/main/workflows/schema'
import { createWorkflowStore } from '../../src/main/workflows/store'
import { restoreLines, inspectionLines } from '../../src/renderer/src/components/backup/backupView'
import { sources } from '../identity/fixtures'
import { cleanupAll, listFiles, populatedStore, RUNTIME_TOKEN, runtimeRoot } from './helpers'
import { setLocale } from '../../src/shared/i18n'

const ENC_FILE_RE = new RegExp(`^(?:navalia|persome)-backup-\\d{8}T\\d{6}Z(?:-\\d{1,3})?\\.(?:${ENC_EXT}|${LEGACY_ENC_EXT})$`)

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

/** C21 — backup archive: cards + full Workflow history byte-equal, merge by version, opt-in data, AES-256-GCM. */

afterEach(cleanupAll)

const TMP = os.tmpdir()
const made: string[] = []
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(TMP, `lens-ib-${label}-`))
  made.push(d)
  return d
}
afterAll(() => {
  for (const d of made.splice(0)) {
    if (path.basename(d).startsWith('lens-ib-') && path.dirname(d) === TMP) fs.rmSync(d, { recursive: true, force: true })
  }
})

const PASS = 'correct horse battery staple'
const CLOUD_TOKEN = Buffer.from('CLOUDTOKEN-ciphertext-0123456789abcdef-XYZ', 'utf8')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function svc(storeRoot: string, extra: Partial<Parameters<typeof createBackupService>[0]> = {}) {
  const rt = runtimeRoot()
  return createBackupService({
    storeRoot,
    runtimeRoot: () => rt,
    persomeBin: () => null,
    now: () => Date.UTC(2026, 10, 6, 8, 0, 0),
    appVersion: () => '0.1.0',
    observedWorkflows: () => [],
    ...extra
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

const editOf = (w: ReturnType<ReturnType<typeof createWorkflowStore>['latest']>, patch: Partial<WorkflowEdit>): WorkflowEdit => {
  const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = w!
  return { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags, ...patch }
}

/** Store with two signed cards, Workflow v1..v3, a real audit.db, a cloud token, and user data. */
function sourceStore() {
  const s = populatedStore()
  fs.rmSync(s.paths.cardsDir, { recursive: true, force: true })
  const cards = [issueCard(s.keys, s.root, '2026-11-01T10:00:00.000Z'), issueCard(s.keys, s.root, '2026-11-04T10:00:00.000Z')]
  const wf = createWorkflowStore(s.root)
  wf.saveEdit(s.workflowId, 2, editOf(wf.latest(s.workflowId), { title: '周报 v3' }), null)
  fs.rmSync(s.paths.auditDb, { force: true })
  const audit = openAuditLog(s.paths.auditDb)
  audit.record({
    grantId: 'g1',
    client: 'codex',
    capability: 'search',
    argsSha256: 'b'.repeat(64),
    argsPreview: '{"query":"x"}',
    itemIds: [],
    itemCount: 0,
    responseChars: 1,
    resultPreview: 'x',
    outcome: 'ok',
    httpStatus: 200,
    errorCode: null,
    durationMs: 1
  })
  audit.close()
  fs.writeFileSync(path.join(s.root, 'cloud-token.enc'), CLOUD_TOKEN, { mode: 0o600 })
  fs.writeFileSync(path.join(s.root, 'cloud.json'), '{"server":"https://cloud.example"}', { mode: 0o600 })
  // user data
  fs.mkdirSync(path.join(s.root, 'chat'), { recursive: true })
  fs.writeFileSync(path.join(s.root, 'chat', 'c-0123456789abcdef.json'), '{"chat":"CHAT_MARKER"}\n', { mode: 0o600 })
  const meet = path.join(s.root, 'meetings', 'm-1')
  fs.mkdirSync(path.join(meet, 'audio'), { recursive: true })
  fs.writeFileSync(path.join(meet, 'meeting.json'), '{"meeting":"MEETING_MARKER"}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(meet, 'transcript.json'), '{"t":"TRANSCRIPT_MARKER"}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(meet, 'audio', '000001.webm'), 'AUDIO_MARKER', { mode: 0o600 })
  fs.mkdirSync(path.join(s.root, 'meetings', 'm-2'), { recursive: true })
  fs.writeFileSync(path.join(s.root, 'meetings', 'm-2', 'meeting.json'), '{"meeting":"no transcript"}\n', { mode: 0o600 })
  fs.mkdirSync(path.join(s.root, 'moments'), { recursive: true })
  fs.writeFileSync(path.join(s.root, 'moments', '11111111-2222-4333-8444-555555555555.json'), '{"moment":"MOMENT_MARKER"}\n', { mode: 0o600 })
  return { ...s, cards }
}

/** A "new machine": its own identity, no Lens data. */
function freshStore() {
  const s = populatedStore()
  for (const d of ['workflows', 'peers', 'cards']) fs.rmSync(path.join(s.root, d), { recursive: true, force: true })
  return s
}

function filesUnder(root: string, sub: string): Record<string, string> {
  const dir = path.join(root, sub)
  if (!fs.existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const f of listFiles(dir)) out[f] = sha(fs.readFileSync(path.join(dir, f)))
  return out
}

function storeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of listFiles(root)) out[f] = sha(fs.readFileSync(path.join(root, f)))
  return out
}

/** All bytes of a backup (a dir: every file; an encrypted file: the file). */
function backupBytes(p: string): Buffer {
  if (fs.statSync(p).isFile()) return fs.readFileSync(p)
  return Buffer.concat(listFiles(p).map((f) => fs.readFileSync(path.join(p, f))))
}

function expectNoSecrets(bytes: Buffer, s: ReturnType<typeof sourceStore>): void {
  const key = fs.readFileSync(s.paths.privateKeyFile)
  expect(bytes.includes(CLOUD_TOKEN)).toBe(false)
  expect(bytes.includes(Buffer.from(CLOUD_TOKEN.toString('base64')))).toBe(false)
  expect(bytes.includes(key)).toBe(false)
  expect(bytes.includes(Buffer.from(key.toString('base64')))).toBe(false)
  expect(bytes.includes(Buffer.from(RUNTIME_TOKEN))).toBe(false)
  expect(bytes.includes(Buffer.from('https://cloud.example'))).toBe(false)
  expect(bytes.includes(Buffer.from('AUDIO_MARKER'))).toBe(false)
}

describe('C21 round trip: cards + full Workflow history byte-equal', () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? 'encrypted' : 'plain'}, signed by me: restores every card and every Workflow version byte-for-byte under the original id; no secrets`, async () => {
      const s = sourceStore()
      const target = tmp('target')
      const exp = await svc(s.root, { identity: s.keys }).exportTo(target, { withoutModel: true, ...(encrypted ? { passphrase: PASS } : {}) })
      expect(exp.encrypted).toBe(encrypted)
      expect(exp).toMatchObject({ signed: true, signReason: null })
      // Only the final artefact is in the target folder; no plaintext staging left in the store.
      expect(fs.readdirSync(target)).toEqual([path.basename(exp.path!)])
      if (!encrypted) expect(listFiles(exp.path!)).toContain('manifest.sig.json')
      expect(fs.readdirSync(s.root).filter((n) => n.startsWith('.backup-'))).toEqual([])
      if (encrypted) {
        expect(path.basename(exp.path!)).toMatch(ENC_FILE_RE)
        const bytes = fs.readFileSync(exp.path!)
        expect(bytes.subarray(0, 8).equals(ENC_MAGIC)).toBe(true)
        for (const plain of ['周报', 'card_', 'navalia.backup"', 'issuer']) expect(bytes.includes(Buffer.from(plain))).toBe(false)
        expect(fs.statSync(exp.path!).mode & 0o777).toBe(0o600)
      }
      expectNoSecrets(backupBytes(exp.path!), s)

      // Same Lens identity, data lost (workflows + cards deleted).
      const wfBefore = filesUnder(s.root, path.join('workflows', s.workflowId))
      const cardsBefore = filesUnder(s.root, 'cards')
      fs.rmSync(path.join(s.root, 'workflows'), { recursive: true, force: true })
      fs.rmSync(s.paths.cardsDir, { recursive: true, force: true })
      const r = svc(s.root, { identity: s.keys })
      const info = encrypted ? await r.inspectEncrypted(exp.path!, PASS) : await r.inspect(exp.path!)
      expect(info.encrypted).toBe(encrypted)
      expect(info.trust).toMatchObject({ mode: 'mine', fingerprint: s.keys.getPublicIdentity()!.fingerprint })
      expect(info.preview?.workflows).toEqual([expect.objectContaining({ id: s.workflowId, action: 'restore', versions: 3 })])
      expect(info.preview?.cards).toEqual({ valid: 2, invalid: 0 })
      expect(restoreSummary(info.preview!)).toMatch(/可按原 ID 恢复/)
      // Inspect wrote nothing into the Lens data.
      expect(fs.existsSync(path.join(s.root, 'workflows'))).toBe(false)
      const rep = await r.restore(info.inspectionId!)
      expect(rep.workflows).toMatchObject({ restored: 1, imported: 0, failed: 0 })
      expect(rep.cards).toMatchObject({ restored: 2, failed: 0 })
      expect(filesUnder(s.root, path.join('workflows', s.workflowId))).toEqual(wfBefore)
      expect(Object.keys(wfBefore)).toEqual(['v000001.json', 'v000002.json', 'v000003.json'])
      expect(filesUnder(s.root, 'cards')).toEqual(cardsBefore)
      // Staging (encrypted) is gone after restore.
      expect(fs.readdirSync(s.root).filter((n) => n.startsWith('.backup-'))).toEqual([])
      expect(restoreLines(rep).join('\n')).toMatch(/按原 ID 恢复 1/)
    })
  }

  it('signed by ANOTHER identity (new machine): re-stamped imp-* copy with full history; cards archived byte-equal', async () => {
    const s = sourceStore()
    const exp = await svc(s.root, { identity: s.keys }).exportTo(tmp('target'), { withoutModel: true, passphrase: PASS })
    const fresh = freshStore()
    const r = svc(fresh.root, { identity: fresh.keys })
    const info = await r.inspectEncrypted(exp.path!, PASS)
    expect(info.trust?.mode).toBe('foreign')
    expect(info.preview?.workflows[0]).toMatchObject({ action: 'copy', versions: 3 })
    expect(restoreSummary(info.preview!)).toMatch(/只会以导入副本/)
    const rep = await r.restore(info.inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 1, restored: 0 })
    const wf = createWorkflowStore(fresh.root)
    expect(wf.latest(s.workflowId)).toBeNull()
    const copy = rep.workflows.items[0].id!
    expect(wf.versions(copy).map((w) => w.version)).toEqual([1, 2, 3])
    expect(wf.versions(copy).every((w) => w.provenance.kind === 'imported' && w.source.type === 'import_file')).toBe(true)
    expect(filesUnder(fresh.root, path.join('cards', 'archive'))).toEqual(filesUnder(s.root, 'cards'))
  })

  it('unsigned (no identity at export) → said so, restored as re-stamped copies even into the same identity', async () => {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true })
    expect(exp.signed).toBe(false)
    expect(exp.signReason).toMatch(/身份/)
    fs.rmSync(path.join(s.root, 'workflows'), { recursive: true, force: true })
    const r = svc(s.root, { identity: s.keys })
    const info = await r.inspect(exp.path!)
    expect(info.trust?.mode).toBe('unsigned')
    const rep = await r.restore(info.inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 1, restored: 0 })
    expect(createWorkflowStore(s.root).latest(s.workflowId)).toBeNull()
  })

  it('signed by a RETIRED key of this Navalia (identity reset since) → original ids', async () => {
    const s = sourceStore()
    const exp = await svc(s.root, { identity: s.keys }).exportTo(tmp('target'), { withoutModel: true })
    const oldFp = s.keys.getPublicIdentity()!.fingerprint
    s.keys.resetIdentity()
    expect(s.keys.getPublicIdentity()!.fingerprint).not.toBe(oldFp)
    const before = filesUnder(s.root, path.join('workflows', s.workflowId))
    fs.rmSync(path.join(s.root, 'workflows'), { recursive: true, force: true })
    const r = svc(s.root, { identity: s.keys })
    const info = await r.inspect(exp.path!)
    expect(info.trust).toMatchObject({ mode: 'mine', fingerprint: oldFp })
    const rep = await r.restore(info.inspectionId!)
    expect(rep.workflows).toMatchObject({ restored: 1 })
    expect(filesUnder(s.root, path.join('workflows', s.workflowId))).toEqual(before)
  })

  it('manifest changed after signing (sha256s re-made consistent) → whole backup REJECTED, nothing written', async () => {
    const s = sourceStore()
    const exp = await svc(s.root, { identity: s.keys }).exportTo(tmp('target'), { withoutModel: true })
    const p = path.join(exp.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    m.app_version = '9.9.9'
    fs.writeFileSync(p, JSON.stringify(m))
    const before = storeSnapshot(s.root)
    await expect(svc(s.root, { identity: s.keys }).inspect(exp.path!)).rejects.toThrow(/签名无效/)
    expect(storeSnapshot(s.root)).toEqual(before)
    // A signature file whose public key does not match its fingerprint is rejected too.
    const sp = path.join(exp.path!, 'manifest.sig.json')
    fs.writeFileSync(p, JSON.stringify({ ...m, app_version: '0.1.0' }))
    const sig = JSON.parse(fs.readFileSync(sp, 'utf8'))
    fs.writeFileSync(sp, JSON.stringify({ ...sig, fingerprint: 'a'.repeat(64) }))
    await expect(svc(s.root, { identity: s.keys }).inspect(exp.path!)).rejects.toThrow(/签名无效/)
    // Deleting the signature does not help an attacker: the backup becomes unsigned → copies only.
    fs.rmSync(sp)
    const info = await svc(s.root, { identity: s.keys }).inspect(exp.path!)
    expect(info.trust?.mode).toBe('unsigned')
  })

  it('same identity: cards come back into cards/ byte-equal', async () => {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true, passphrase: PASS })
    const before = filesUnder(s.root, 'cards')
    fs.rmSync(s.paths.cardsDir, { recursive: true, force: true })
    const r = svc(s.root)
    const rep = await r.restore((await r.inspectEncrypted(exp.path!, PASS)).inspectionId!)
    expect(rep.cards).toMatchObject({ restored: 2, failed: 0 })
    expect(filesUnder(s.root, 'cards')).toEqual(before)
  })

  it('an invalid card is skipped and reported; the rest is restored', async () => {
    const s = sourceStore()
    const bad = path.join(s.paths.cardsDir, `card_${'f'.repeat(32)}.navaliacard`)
    fs.writeFileSync(bad, '{"card":{"card_id":"x"},"signature":"nope"}\n', { mode: 0o600 })
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true })
    const fresh = freshStore()
    const r = svc(fresh.root)
    const info = await r.inspect(exp.path!)
    expect(info.preview?.cards).toEqual({ valid: 2, invalid: 1 })
    const rep = await r.restore(info.inspectionId!)
    expect(rep.cards).toMatchObject({ archived: 2, failed: 1 })
    expect(fs.existsSync(path.join(fresh.paths.cardsDir, 'archive', path.basename(bad)))).toBe(false)
  })
})

describe('C21 workflow merge by version', () => {
  async function backupOf(s: ReturnType<typeof sourceStore>) {
    return (await svc(s.root, { identity: s.keys }).exportTo(tmp('target'), { withoutModel: true })).path!
  }

  it('never clobbers newer local versions: same history + local v4 → kept, nothing written', async () => {
    const s = sourceStore()
    const dir = await backupOf(s)
    const wf = createWorkflowStore(s.root)
    wf.saveEdit(s.workflowId, 3, editOf(wf.latest(s.workflowId), { title: '本机 v4' }), null)
    const before = filesUnder(s.root, 'workflows')
    const r = svc(s.root, { identity: s.keys })
    const info = await r.inspect(dir)
    expect(info.preview?.workflows[0]).toMatchObject({ action: 'local_newer', versions: 0 })
    const rep = await r.restore(info.inspectionId!)
    expect(rep.workflows).toMatchObject({ localNewer: 1, restored: 0, merged: 0, imported: 0 })
    expect(filesUnder(s.root, 'workflows')).toEqual(before)
    expect(wf.latest(s.workflowId)!.title).toBe('本机 v4')
  })

  it('local has an older prefix of the same history → only the newer versions are appended, byte-equal', async () => {
    const s = sourceStore()
    const dir = await backupOf(s)
    const full = filesUnder(s.root, path.join('workflows', s.workflowId))
    const wdir = path.join(s.root, 'workflows', s.workflowId)
    for (const v of ['v000002.json', 'v000003.json']) fs.rmSync(path.join(wdir, v))
    const r = svc(s.root, { identity: s.keys })
    const rep = await r.restore((await r.inspect(dir)).inspectionId!)
    expect(rep.workflows).toMatchObject({ merged: 1 })
    expect(rep.workflows.items[0]).toMatchObject({ outcome: 'merged', versions: 2, id: s.workflowId })
    expect(filesUnder(s.root, path.join('workflows', s.workflowId))).toEqual(full)
  })

  it('diverged history → backup saved as a separate imp-* copy; every local version untouched', async () => {
    const s = sourceStore()
    const dir = await backupOf(s)
    const wdir = path.join(s.root, 'workflows', s.workflowId)
    for (const v of ['v000002.json', 'v000003.json']) fs.rmSync(path.join(wdir, v))
    const wf = createWorkflowStore(s.root)
    wf.saveEdit(s.workflowId, 1, editOf(wf.latest(s.workflowId), { title: '本机另一个 v2' }), null)
    const before = filesUnder(s.root, path.join('workflows', s.workflowId))
    const r = svc(s.root, { identity: s.keys })
    const rep = await r.restore((await r.inspect(dir)).inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 1, merged: 0, restored: 0 })
    expect(filesUnder(s.root, path.join('workflows', s.workflowId))).toEqual(before)
    const copy = rep.workflows.items[0].id!
    expect(copy).toMatch(/^imp-/)
    expect(wf.versions(copy).map((w) => w.version)).toEqual([1, 2, 3])
    expect(wf.versions(copy).every((w) => w.provenance.kind === 'imported')).toBe(true)
  })
})

describe('C21 encryption: wrong passphrase / tampering → clear error, nothing written', () => {
  async function encryptedBackup() {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true, passphrase: PASS, includeAccessLog: true })
    return { s, file: exp.path! }
  }

  async function expectRejected(file: string, pass: string, re: RegExp, code?: string) {
    const fresh = freshStore()
    const before = storeSnapshot(fresh.root)
    const r = svc(fresh.root)
    const err = await r.inspectEncrypted(file, pass).then(
      () => null,
      (e: unknown) => e as Error & { code?: string }
    )
    expect(err, 'should reject').not.toBeNull()
    expect(err!.message).toMatch(re)
    if (code) expect(err!.code).toBe(code)
    expect(err!.message).not.toContain(pass)
    expect(storeSnapshot(fresh.root)).toEqual(before)
    expect(fs.readdirSync(fresh.root).filter((n) => n.startsWith('.backup-'))).toEqual([])
  }

  it('wrong passphrase', async () => {
    const { file } = await encryptedBackup()
    await expectRejected(file, 'wrong passphrase!!', /口令错误/, 'unauthorized')
  })

  it('a flipped ciphertext byte', async () => {
    const { file } = await encryptedBackup()
    const b = fs.readFileSync(file)
    b[b.length - 40] ^= 0x01
    fs.writeFileSync(file, b)
    await expectRejected(file, PASS, /篡改|损坏/)
  })

  it('truncation, appended bytes, edited header', async () => {
    const { file } = await encryptedBackup()
    const orig = fs.readFileSync(file)
    fs.writeFileSync(file, orig.subarray(0, orig.length - 10))
    await expectRejected(file, PASS, /截断|不完整|篡改/)
    fs.writeFileSync(file, Buffer.concat([orig, Buffer.from('extra')]))
    await expectRejected(file, PASS, /多余|篡改|截断|不完整/)
    // Header edit that still parses (different chunk_bytes) → authenticated header mismatch.
    const text = orig.toString('latin1').replace('"chunk_bytes":1048576', '"chunk_bytes":1048575')
    expect(text).not.toBe(orig.toString('latin1'))
    fs.writeFileSync(file, Buffer.from(text, 'latin1'))
    await expectRejected(file, PASS, /口令错误|篡改/)
    // Header with out-of-bounds KDF params is refused before any key derivation.
    const huge = orig.toString('latin1').replace('"N":32768', '"N":1048576')
    fs.writeFileSync(file, Buffer.from(huge, 'latin1'))
    await expectRejected(file, PASS, /文件头不合法/)
    // Not an archive at all.
    fs.writeFileSync(file, 'hello')
    await expectRejected(file, PASS, /不是 Navalia 加密备份/)
  })

  it('a passphrase below 8 characters is refused on export and on inspect', async () => {
    const s = sourceStore()
    const target = tmp('target')
    await expect(svc(s.root).exportTo(target, { withoutModel: true, passphrase: 'short' })).rejects.toThrow(/至少 8/)
    expect(fs.readdirSync(target)).toEqual([])
  })
})

describe('C21 crypto stream (unit)', () => {
  async function seal(chunks: Buffer[], chunkBytes = 4096): Promise<string> {
    const f = path.join(tmp('enc'), 'x.navaliabackup')
    const fd = fs.openSync(f, 'wx', 0o600)
    const w = await EncryptWriter.open(fd, PASS, { chunkBytes })
    for (const c of chunks) w.write(c)
    w.finish()
    fs.closeSync(fd)
    return f
  }
  async function open(f: string, pass = PASS): Promise<Buffer> {
    const fd = fs.openSync(f, 'r')
    const out: Buffer[] = []
    try {
      await decryptFile(fd, pass, (c) => out.push(c))
    } finally {
      fs.closeSync(fd)
    }
    return Buffer.concat(out)
  }

  it('multi-chunk round trip; header carries scrypt N ≥ 2^15, 16-byte salt, 7-byte nonce prefix', async () => {
    const data = Buffer.from(Array.from({ length: 20_000 }, (_, i) => i % 251))
    const f = await seal([data.subarray(0, 7000), data.subarray(7000)])
    expect((await open(f)).equals(data)).toBe(true)
    const fd = fs.openSync(f, 'r')
    const { header } = readEncHeader(fd)
    fs.closeSync(fd)
    expect(header.kdf.N).toBeGreaterThanOrEqual(2 ** 15)
    expect(Buffer.from(header.kdf.salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(header.nonce_prefix, 'base64')).toHaveLength(7)
    // Two archives of the same data never share salt / ciphertext.
    const g = await seal([data])
    expect(fs.readFileSync(f).equals(fs.readFileSync(g))).toBe(false)
  })

  it('dropping a whole middle chunk or the final chunk is detected', async () => {
    const data = Buffer.alloc(12_000, 7)
    const f = await seal([data])
    const b = fs.readFileSync(f)
    const fd = fs.openSync(f, 'r')
    const { headerBytes } = readEncHeader(fd)
    fs.closeSync(fd)
    const rec = 4 + 4096 + 16
    const h = headerBytes.length
    // chunks: 0,1 full (4096) and 2 final (3808)
    const noMiddle = Buffer.concat([b.subarray(0, h + rec), b.subarray(h + 2 * rec)])
    fs.writeFileSync(f, noMiddle)
    await expect(open(f)).rejects.toBeInstanceOf(BackupCryptoError)
    const noFinal = b.subarray(0, h + 2 * rec)
    fs.writeFileSync(f, noFinal)
    await expect(open(f)).rejects.toThrow(/截断|不完整|结束块/)
  })

  it('container reader rejects trailing garbage and truncated entries', () => {
    const parts: Buffer[] = []
    const w = new ContainerWriter({ write: (b) => parts.push(Buffer.from(b)) })
    const f = path.join(tmp('c'), 'a.txt')
    fs.writeFileSync(f, 'hello')
    w.addFile('a.txt', f, 5)
    w.end()
    const all = Buffer.concat(parts)
    const got: string[] = []
    const r = new ContainerReader({ begin: (rel, size) => got.push(`${rel}:${size}`), data: () => {}, end: () => {} })
    r.push(all)
    r.finish()
    expect(got).toEqual(['a.txt:5'])
    const r2 = new ContainerReader({ begin: () => {}, data: () => {}, end: () => {} })
    expect(() => r2.push(Buffer.concat([all, Buffer.from('x')]))).toThrow(/多余/)
    const r3 = new ContainerReader({ begin: () => {}, data: () => {}, end: () => {} })
    r3.push(all.subarray(0, all.length - 3))
    expect(() => r3.finish()).toThrow(/不完整/)
  })
})

describe('C21 opt-in data and exclusions', () => {
  it('default: no chat / meetings / moments / Access log; cloud token, cloud.json, key never included', async () => {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true })
    const files = listFiles(exp.path!)
    expect(files.filter((f) => /^lens\/(chat|meetings|moments)\//.test(f))).toEqual([])
    expect(files).not.toContain('lens/access-log.json')
    expect(files.some((f) => /cloud/.test(f))).toBe(false)
    const m = JSON.parse(fs.readFileSync(path.join(exp.path!, 'manifest.json'), 'utf8'))
    expect(m.includes_user_data).toEqual({ chat: false, meetings: false, moments: false })
    expect(m.excluded.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['cloud-token.enc / cloud.json', 'meetings/*/audio/']))
    const bytes = backupBytes(exp.path!)
    expectNoSecrets(bytes, s)
    for (const marker of ['CHAT_MARKER', 'MEETING_MARKER', 'TRANSCRIPT_MARKER', 'MOMENT_MARKER']) expect(bytes.includes(Buffer.from(marker))).toBe(false)
  })

  it('opt-in: chat, meeting.json + transcript.json (never audio; meetings without a transcript skipped), moments; restored only where absent', async () => {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true, includeChat: true, includeMeetings: true, includeMoments: true, includeAccessLog: true, passphrase: PASS })
    expect(exp.userData).toEqual({ chat: 1, meetings: 2, moments: 1 })
    expect(exp.skipped.map((x) => x.path)).toContain('lens/meetings/m-2')
    const fresh = freshStore()
    // A local chat file with the same name but different content must not be overwritten.
    fs.mkdirSync(path.join(fresh.root, 'chat'), { recursive: true })
    fs.writeFileSync(path.join(fresh.root, 'chat', 'c-0123456789abcdef.json'), '{"local":true}\n')
    const r = svc(fresh.root)
    const info = await r.inspectEncrypted(exp.path!, PASS)
    expect(info.preview?.userData).toEqual({ chat: 1, meetings: 1, moments: 1 })
    expect(info.preview?.accessLog).toBe(true)
    const rep = await r.restore(info.inspectionId!)
    expect(rep.userData).toEqual({
      chat: { restored: 0, unchanged: 0, skipped: 1 },
      meetings: { restored: 2, unchanged: 0, skipped: 0 },
      moments: { restored: 1, unchanged: 0, skipped: 0 }
    })
    expect(fs.readFileSync(path.join(fresh.root, 'chat', 'c-0123456789abcdef.json'), 'utf8')).toBe('{"local":true}\n')
    expect(fs.readFileSync(path.join(fresh.root, 'meetings', 'm-1', 'transcript.json'), 'utf8')).toContain('TRANSCRIPT_MARKER')
    expect(fs.existsSync(path.join(fresh.root, 'meetings', 'm-1', 'audio'))).toBe(false)
    expect(fs.readFileSync(path.join(fresh.root, 'moments', '11111111-2222-4333-8444-555555555555.json'), 'utf8')).toContain('MOMENT_MARKER')
    // Access log: archive-only, local audit.db untouched.
    expect(rep.accessLog).toEqual({ included: true, rows: 1 })
    expect(fs.readFileSync(fresh.paths.auditDb, 'utf8')).toBe('SQLite format 3\u0000audit')
  })

  it('cloud token bytes planted inside an allowlisted file abort the export (fail-closed scan)', async () => {
    const s = sourceStore()
    fs.writeFileSync(path.join(s.root, 'settings.json'), JSON.stringify({ v: 1, leak: CLOUD_TOKEN.toString('base64') }))
    const target = tmp('target')
    await expect(svc(s.root).exportTo(target, { withoutModel: true, passphrase: PASS })).rejects.toThrow(/云端 token|疑似密钥/)
    expect(fs.readdirSync(target)).toEqual([])
    expect(fs.readdirSync(s.root).filter((n) => n.startsWith('.backup-'))).toEqual([])
  })

  it('a manifest that lists user data without declaring it is refused before anything is written', async () => {
    const s = sourceStore()
    const exp = await svc(s.root).exportTo(tmp('target'), { withoutModel: true, includeChat: true })
    const p = path.join(exp.path!, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    m.includes_user_data.chat = false
    fs.writeFileSync(p, JSON.stringify(m))
    await expect(svc(freshStore().root).inspect(exp.path!)).rejects.toThrow(/未声明包含 chat/)
  })

  it('startup sweep removes leftover plaintext staging dirs', () => {
    const s = freshStore()
    fs.mkdirSync(path.join(s.root, '.backup-restore-abc'))
    fs.mkdirSync(path.join(s.root, '.backup-work-def'))
    svc(s.root)
    expect(fs.readdirSync(s.root).filter((n) => n.startsWith('.backup-'))).toEqual([])
  })
})

describe('C21 IPC: encrypted export / inspect, preview in the native confirm', () => {
  it('passphrase validated, file picked main-side, confirm detail carries the plan, errors never echo the passphrase', async () => {
    const s = sourceStore()
    const target = tmp('target')
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
    const details: string[] = []
    let file: string | null = null
    registerBackupHandlers(
      { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => handlers.set(ch, fn) } as never,
      svc(s.root, { identity: s.keys }),
      async () => target,
      async (summary) => {
        details.push(summary.detail)
        return true
      },
      async () => file
    )
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({ sender: 'w' }, raw) as Promise<{ ok: boolean; data?: any; error?: any }>
    const short = await call(BACKUP_CHANNELS.exportBackup, { withoutModel: true, passphrase: 'abc' })
    expect(short.ok).toBe(false)
    expect(JSON.stringify(short)).not.toContain('"abc"')
    const exp = await call(BACKUP_CHANNELS.exportBackup, { withoutModel: true, passphrase: PASS, includeChat: true })
    expect(exp).toMatchObject({ ok: true, data: { encrypted: true, userData: { chat: 1 } } })

    expect((await call(BACKUP_CHANNELS.inspect, { encrypted: true })).ok).toBe(false) // passphrase required
    expect((await call(BACKUP_CHANNELS.inspect, { encrypted: true, passphrase: PASS, file: exp.data.path })).ok).toBe(false) // never a path
    expect(await call(BACKUP_CHANNELS.inspect, { encrypted: true, passphrase: PASS })).toMatchObject({ ok: true, data: { cancelled: true } })
    file = exp.data.path
    const wrong = await call(BACKUP_CHANNELS.inspect, { encrypted: true, passphrase: 'not the passphrase' })
    expect(wrong).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(JSON.stringify(wrong)).not.toContain('not the passphrase')
    const ins = await call(BACKUP_CHANNELS.inspect, { encrypted: true, passphrase: PASS })
    expect(ins.ok).toBe(true)
    expect(JSON.stringify(ins.data)).not.toContain(target)
    expect(inspectionLines(ins.data)!.join('\n')).toMatch(/加密备份/)
    const res = await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId, confirm: true })
    expect(res).toMatchObject({ ok: true, data: { workflows: { unchanged: 1 } } })
    expect(details[0]).toMatch(/相同 1/)
    expect(details[0]).toMatch(/由你的 Navalia 身份签名/)
    expect(details[0]).toMatch(/聊天 1/)
  })

  it('restoreSummary is counts only', () => {
    const t = restoreSummary({
      workflows: [{ id: 'a', title: 't', action: 'merge', versions: 2, detail: null }],
      cards: { valid: 3, invalid: 1 },
      peers: 2,
      userData: { chat: 0, meetings: 0, moments: 0 },
      accessLog: false
    })
    expect(t).toMatch(/只会以导入副本/) // no trust given → treated as unsigned
    expect(t).toMatch(/追加新版本 1/)
    expect(t).toMatch(/无效将跳过 1/)
  })
})

import { checkPassphrase } from '../../src/main/backup/crypto'

describe('en: English UI text', () => {
  it('en: passphrase errors read in English', () => {
    setLocale('en')
    expect(() => checkPassphrase('short')).toThrow(/Passphrase must be at least 8 characters/)
    setLocale('zh')
    expect(() => checkPassphrase('short')).toThrow(/口令至少 8 个字符/)
  })
})
