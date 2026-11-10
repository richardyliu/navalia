import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { BACKUP_CHANNELS } from '../../src/main/backup/api'
import { registerBackupHandlers } from '../../src/main/backup/ipc'
import { createBackupService, ManifestSchema, scanForSecrets } from '../../src/main/backup/service'
import type { ExecFn } from '../../src/main/import/cli'
import { createPeerStore } from '../../src/main/peers/store'
import { createWorkflowStore } from '../../src/main/workflows/store'
import { cleanupAll, fakePersome, listFiles, observed, populatedStore, RUNTIME_TOKEN, runtimeRoot, SCREENSHOT_KEY, tempDir } from './helpers'
import { setLocale } from '../../src/shared/i18n'

const BACKUP_DIR_RE = /^(?:navalia|persome)-backup-\d{8}T\d{6}Z(?:-\d{1,3})?$/

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

afterEach(cleanupAll)

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function service(opts: { storeRoot: string; runtime?: string; bin?: string | null; exec?: ExecFn; onCopy?: (rel: string) => void }) {
  const rt = opts.runtime ?? runtimeRoot()
  return {
    rt,
    svc: createBackupService({
      storeRoot: opts.storeRoot,
      runtimeRoot: () => rt,
      persomeBin: () => (opts.bin === undefined ? fakePersome() : opts.bin),
      exec: opts.exec,
      onCopy: opts.onCopy,
      now: () => Date.UTC(2026, 10, 5, 9, 30, 0),
      appVersion: () => '0.1.0'
    })
  }
}

describe('backup export', () => {
  it('runs `persome model export --out` with PERSOME_ROOT via execFile and writes an atomic backup dir', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc, rt } = service({ storeRoot: s.root })
    const r = await svc.exportTo(parent, { withoutModel: false })
    expect(r.cancelled).toBe(false)
    expect(path.basename(r.path!)).toMatch(BACKUP_DIR_RE)
    expect(path.basename(r.path!)).toBe('navalia-backup-20261105T093000Z')
    // Only the final dir remains (no temp leftovers).
    expect(fs.readdirSync(parent)).toEqual(['navalia-backup-20261105T093000Z'])
    const argv = fs.readFileSync(path.join(rt, 'fake-argv.txt'), 'utf8').trim().split('\n')
    expect(argv.slice(0, 3)).toEqual(['model', 'export', '--out'])
    expect(argv).toHaveLength(4)
    expect(argv).not.toContain('--raw')
    expect(path.basename(argv[3])).toBe('model-snapshot.json')
    expect(path.dirname(path.dirname(argv[3]))).toBe(fs.realpathSync(parent))
    expect(path.basename(path.dirname(argv[3]))).toMatch(/^\.navalia-backup-.*\.tmp-/)
    expect(fs.readFileSync(path.join(rt, 'fake-root.txt'), 'utf8').trim()).toBe(rt)
    expect(fs.statSync(r.path!).mode & 0o777).toBe(0o700)
  })

  it('never includes the private key, identity, grants, audit, het.db, import staging or Runtime secrets', async () => {
    const s = populatedStore()
    // A symlink inside an allowlisted dir pointing at grants.json must not be followed.
    fs.symlinkSync(s.paths.grantsFile, path.join(s.root, 'workflows', 'grants-link.json'))
    fs.symlinkSync(s.paths.privateKeyFile, path.join(s.root, 'cards', 'key-link'))
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root })
    const r = await svc.exportTo(parent, { withoutModel: false })
    const files = listFiles(r.path!)
    expect(files).toContain('manifest.json')
    expect(files).toContain('model-snapshot.json')
    expect(files).toContain('lens/settings.json')
    expect(files).toContain('lens/het-settings.json')
    expect(files.some((f) => f.startsWith('lens/workflows/rt-weekly-report/v000002.json'))).toBe(true)
    expect(files.some((f) => /^lens\/peers\/[0-9a-f]{64}\.json$/.test(f))).toBe(true)
    expect(files.some((f) => f.startsWith('lens/cards/'))).toBe(true)
    for (const f of files) {
      expect(f).not.toMatch(/identity|ed25519|grants|audit|het\.db|import|key-link/)
    }
    const keyBytes = fs.readFileSync(s.paths.privateKeyFile)
    for (const f of files) {
      const b = fs.readFileSync(path.join(r.path!, f))
      expect(sha(b)).not.toBe(sha(keyBytes))
      expect(b.toString('utf8')).not.toContain(RUNTIME_TOKEN)
      expect(b.toString('utf8')).not.toContain(SCREENSHOT_KEY)
      expect(b.toString('utf8')).not.toContain('token_hash')
      expect(fs.statSync(path.join(r.path!, f)).mode & 0o777).toBe(0o600)
    }
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(r.path!, 'manifest.json'), 'utf8')))
    expect(manifest.format).toBe('navalia.backup')
    expect(manifest.app_version).toBe('0.1.0')
    expect(manifest.model_snapshot).toMatchObject({ status: 'included', exit_code: 0, args: ['model', 'export', '--out', '<backup>/model-snapshot.json'] })
    expect(manifest.excluded.map((e) => e.path)).toEqual(expect.arrayContaining(['identity/', 'grants.json', 'audit.db', 'het.db', 'import/']))
    expect(manifest.skipped.map((e) => e.path)).toEqual(expect.arrayContaining(['lens/workflows/grants-link.json', 'lens/cards/key-link']))
    for (const f of manifest.files) {
      const b = fs.readFileSync(path.join(r.path!, f.path))
      expect(b.length).toBe(f.bytes)
      expect(sha(b)).toBe(f.sha256)
    }
    expect(r.excluded.length).toBeGreaterThan(0)
  })

  it('CLI exit ≠ 0: fails with exit code + redacted stderr and leaves nothing behind', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root, bin: fakePersome('fail') })
    const err = await svc.exportTo(parent, { withoutModel: false }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('退出码 3')
    expect((err as Error).message).toContain('index locked')
    expect((err as Error).message).not.toContain('LEAKLEAKLEAK')
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('CLI succeeds without writing the snapshot → fails, nothing left', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root, bin: fakePersome('no-output') })
    await expect(svc.exportTo(parent, { withoutModel: false })).rejects.toThrow(/没有生成快照/)
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('copy failure mid-way leaves no backup dir and no temp dir', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    let n = 0
    const { svc } = service({
      storeRoot: s.root,
      onCopy: () => {
        if (++n === 2) throw new Error('disk full')
      }
    })
    await expect(svc.exportTo(parent, { withoutModel: false })).rejects.toThrow(/disk full/)
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('secret scan: a Runtime token found in the produced backup aborts the export', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root, bin: fakePersome('leak') })
    await expect(svc.exportTo(parent, { withoutModel: false })).rejects.toThrow(/疑似密钥/)
    expect(fs.readdirSync(parent)).toEqual([])
    // Also from the Lens side (a PEM block pasted into a workflow-adjacent file).
    fs.writeFileSync(path.join(s.root, 'cards', 'note.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n')
    const { svc: svc2 } = service({ storeRoot: s.root })
    await expect(svc2.exportTo(parent, { withoutModel: false })).rejects.toThrow(/私钥 PEM/)
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('scanForSecrets flags forbidden names, PEM, exact secrets and key copies only', () => {
    const key = Buffer.from('encrypted-key-bytes')
    const probs = scanForSecrets(
      [
        { rel: 'lens/workflows/env-setup/v000001.json', data: Buffer.from('{}') },
        { rel: 'lens/identity/identity.json', data: Buffer.from('{}') },
        { rel: 'lens/cards/x', data: key },
        { rel: 'lens/cards/y', data: Buffer.from(`t=${RUNTIME_TOKEN}`) },
        { rel: 'lens/grants.json', data: Buffer.from('{}') }
      ],
      [RUNTIME_TOKEN],
      key
    )
    expect(probs.join('\n')).not.toContain('env-setup')
    expect(probs).toHaveLength(4)
  })

  it('missing CLI: refuses unless withoutModel; withoutModel backs up Navalia data only', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root, bin: null })
    await expect(svc.exportTo(parent, { withoutModel: false })).rejects.toMatchObject({ code: 'runtime_missing' })
    expect(fs.readdirSync(parent)).toEqual([])
    const r = await svc.exportTo(parent, { withoutModel: true })
    expect(r.modelSnapshot).toBe('not_requested')
    expect(listFiles(r.path!)).not.toContain('model-snapshot.json')
  })

  it('refuses a target inside the Navalia Store or Runtime root, and a relative path', async () => {
    const s = populatedStore()
    const { svc, rt } = service({ storeRoot: s.root })
    await expect(svc.exportTo(path.join(s.root, 'cards'), { withoutModel: true })).rejects.toThrow(/Navalia 数据目录/)
    await expect(svc.exportTo(rt, { withoutModel: true })).rejects.toThrow(/Runtime 数据目录/)
    await expect(svc.exportTo('relative/dir', { withoutModel: true })).rejects.toThrow(/绝对路径/)
  })

  it('a second export in the same second gets a distinct name', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root })
    const a = await svc.exportTo(parent, { withoutModel: true })
    const b = await svc.exportTo(parent, { withoutModel: true })
    expect(path.basename(b.path!)).toBe(`${path.basename(a.path!)}-2`)
  })
})

async function makeBackup() {
  const s = populatedStore()
  const parent = tempDir('target')
  const { svc } = service({ storeRoot: s.root })
  const r = await svc.exportTo(parent, { withoutModel: false })
  return { source: s, dir: r.path! }
}

function rewriteManifest(dir: string, edit: (m: Record<string, unknown> & { files: Array<{ path: string; bytes: number; sha256: string }> }) => void): void {
  const p = path.join(dir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(p, 'utf8'))
  edit(m)
  fs.writeFileSync(p, JSON.stringify(m))
}

describe('backup restore', () => {
  it('round-trips workflows and peers into a fresh store, never touching identity', async () => {
    const { source, dir } = await makeBackup()
    const fresh = populatedStoreFreshIdentity()
    const before = snapshotDir(path.join(fresh.root, 'identity'))
    const { svc } = service({ storeRoot: fresh.root })
    const info = await svc.inspect(dir)
    expect(info).toMatchObject({ cancelled: false, modelSnapshot: true, counts: { workflows: 1, peers: 1, cards: 1 } })
    const rep = await svc.restore(info.inspectionId!)
    // C21: this backup is unsigned (no identity injected) → safe path: re-stamped imp-* copy (D36 / L4).
    expect(rep.trust?.mode).toBe('unsigned')
    expect(rep.workflows).toMatchObject({ imported: 1, restored: 0, duplicates: 0, failed: 0 })
    expect(rep.peers).toMatchObject({ added: 1, failed: 0 })
    expect(rep.notRestored.join('\n')).toContain('模型快照')

    const wf = createWorkflowStore(fresh.root).listLatest()
    expect(wf).toHaveLength(1)
    expect(wf[0].title).toBe('周报（我的版本）')
    expect(wf[0].id).not.toBe(source.workflowId) // never re-uses a (possibly observed) id
    expect(wf[0].provenance).toMatchObject({ kind: 'imported', original_id: source.workflowId })
    const peers = createPeerStore({ storeRoot: fresh.root }).list()
    expect(peers.peers.map((p) => p.fingerprint)).toEqual([source.friend.fingerprint])
    expect(snapshotDir(path.join(fresh.root, 'identity'))).toEqual(before)
    expect(fs.existsSync(path.join(fresh.root, 'grants.json'))).toBe(false)
    expect(fs.existsSync(path.join(fresh.root, 'settings.json'))).toBe(false)

    // Second restore: everything is a duplicate / unchanged; inspection ids are single-use.
    await expect(svc.restore(info.inspectionId!)).rejects.toThrow(/重新选择/)
    const again = await svc.restore((await svc.inspect(dir)).inspectionId!)
    expect(again.workflows).toMatchObject({ imported: 0, duplicates: 1 })
    expect(again.peers).toMatchObject({ added: 0, unchanged: 1 })
  })

  it('restoring an unsigned backup into the source store keeps existing ids and reports duplicates', async () => {
    const { source, dir } = await makeBackup()
    const { svc } = service({ storeRoot: source.root })
    const rep = await svc.restore((await svc.inspect(dir)).inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 0, restored: 0, duplicates: 1 })
    expect(createWorkflowStore(source.root).versions(source.workflowId)).toHaveLength(2)
  })

  it('refuses a tampered file (sha256 mismatch) before writing anything', async () => {
    const { dir } = await makeBackup()
    const f = listFiles(dir).find((p) => p.startsWith('lens/workflows/'))!
    fs.appendFileSync(path.join(dir, f), ' ')
    const fresh = tempDir('fresh')
    const { svc } = service({ storeRoot: fresh })
    await expect(svc.inspect(dir)).rejects.toThrow(/校验失败/)
    expect(fs.readdirSync(fresh)).toEqual([])
  })

  it('refuses a tampered model snapshot too', async () => {
    const { dir } = await makeBackup()
    fs.appendFileSync(path.join(dir, 'model-snapshot.json'), ' ')
    const { svc } = service({ storeRoot: tempDir('fresh') })
    await expect(svc.inspect(dir)).rejects.toThrow(/model-snapshot/)
  })

  it('refuses path traversal, non-allowlisted paths, bad format, duplicates and symlinks', async () => {
    const { dir } = await makeBackup()
    const { svc } = service({ storeRoot: tempDir('fresh') })
    const original = fs.readFileSync(path.join(dir, 'manifest.json'))
    const cases: Array<(m: Parameters<Parameters<typeof rewriteManifest>[1]>[0]) => void> = [
      (m) => m.files.push({ path: 'lens/workflows/../../identity/ed25519.key.enc', bytes: 1, sha256: '0'.repeat(64) }),
      (m) => m.files.push({ path: '/etc/passwd', bytes: 1, sha256: '0'.repeat(64) }),
      (m) => m.files.push({ path: 'lens/grants.json', bytes: 1, sha256: '0'.repeat(64) }),
      (m) => m.files.push({ path: 'lens/identity/identity.json', bytes: 1, sha256: '0'.repeat(64) }),
      (m) => m.files.push({ ...m.files[0] }),
      (m) => (m.format = 'something-else'),
      (m) => (m.extra = 1)
    ]
    for (const c of cases) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), original)
      rewriteManifest(dir, c)
      await expect(svc.inspect(dir)).rejects.toMatchObject({ code: 'schema' })
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), original)
    // A listed file replaced by a symlink.
    const f = listFiles(dir).find((p) => p.startsWith('lens/peers/'))!
    const abs = path.join(dir, f)
    const copy = path.join(tempDir('elsewhere'), 'x.json')
    fs.copyFileSync(abs, copy)
    fs.rmSync(abs)
    fs.symlinkSync(copy, abs)
    await expect(svc.inspect(dir)).rejects.toMatchObject({ code: 'schema' })
    // Not a backup at all.
    await expect(svc.inspect(tempDir('empty'))).rejects.toThrow(/manifest\.json/)
  })

  it('refuses a restore when the backup changed after inspection', async () => {
    const { dir } = await makeBackup()
    const { svc } = service({ storeRoot: tempDir('fresh') })
    const info = await svc.inspect(dir)
    rewriteManifest(dir, (m) => (m.created_at = '2020-01-01T00:00:00.000Z'))
    await expect(svc.restore(info.inspectionId!)).rejects.toThrow(/发生了变化/)
  })

  it('re-verifies peer signatures: a forged card with a consistent manifest is reported as failed', async () => {
    const { dir } = await makeBackup()
    const f = listFiles(dir).find((p) => p.startsWith('lens/peers/'))!
    const abs = path.join(dir, f)
    const peer = JSON.parse(fs.readFileSync(abs, 'utf8'))
    peer.history[0].card.card.content.front.summary = '被篡改的摘要'
    fs.writeFileSync(abs, JSON.stringify(peer))
    const b = fs.readFileSync(abs)
    rewriteManifest(dir, (m) => {
      const e = m.files.find((x) => x.path === f)!
      e.bytes = b.length
      e.sha256 = sha(b)
    })
    const fresh = tempDir('fresh')
    const { svc } = service({ storeRoot: fresh })
    const rep = await svc.restore((await svc.inspect(dir)).inspectionId!)
    expect(rep.peers).toMatchObject({ added: 0, failed: 1 })
    expect(createPeerStore({ storeRoot: fresh }).list().peers).toHaveLength(0)
  })
})

describe('backup IPC', () => {
  function fakeIpc() {
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
    return { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => handlers.set(ch, fn), handlers }
  }

  it('validates payloads, handles cancel, never takes a path from the renderer', async () => {
    const s = populatedStore()
    const parent = tempDir('target')
    const { svc } = service({ storeRoot: s.root })
    const ipc = fakeIpc()
    let pickResult: string | null = null
    registerBackupHandlers(ipc as never, svc, async () => pickResult, async () => true)
    const call = (ch: string, raw?: unknown) => ipc.handlers.get(ch)!(null, raw) as Promise<{ ok: boolean; data?: any; error?: any }>

    expect((await call(BACKUP_CHANNELS.exportBackup, { withoutModel: 'no' })).ok).toBe(false)
    expect((await call(BACKUP_CHANNELS.exportBackup, { withoutModel: true, path: '/tmp' })).ok).toBe(false)
    expect(await call(BACKUP_CHANNELS.exportBackup, { withoutModel: true })).toMatchObject({ ok: true, data: { cancelled: true } })
    pickResult = parent
    const exp = await call(BACKUP_CHANNELS.exportBackup, { withoutModel: false })
    expect(exp).toMatchObject({ ok: true, data: { cancelled: false, modelSnapshot: 'included' } })

    expect((await call(BACKUP_CHANNELS.inspect, { dir: parent })).ok).toBe(false)
    pickResult = exp.data.path
    const ins = await call(BACKUP_CHANNELS.inspect)
    expect(ins.ok).toBe(true)
    expect(JSON.stringify(ins.data)).not.toContain(parent)
    expect((await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId })).ok).toBe(false)
    expect((await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId, confirm: false })).ok).toBe(false)
    const res = await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId, confirm: true })
    expect(res).toMatchObject({ ok: true, data: { workflows: { duplicates: 1 } } })
  })

  it('error messages are scrubbed', async () => {
    const s = populatedStore()
    const { svc } = service({ storeRoot: s.root, bin: fakePersome('fail') })
    const ipc = fakeIpc()
    registerBackupHandlers(ipc as never, svc, async () => tempDir('target'), async () => true)
    const r = (await ipc.handlers.get(BACKUP_CHANNELS.exportBackup)!(null, { withoutModel: false })) as { ok: boolean; error: { message: string } }
    expect(r.ok).toBe(false)
    expect(r.error.message).toContain('退出码 3')
    expect(r.error.message).not.toMatch(/sk-ant-api03-LEAK/)
  })
})

/** A fresh store that already has its own identity (restore must leave it alone). */
function populatedStoreFreshIdentity() {
  const s = populatedStore()
  // Remove the populated data but keep identity: the "new machine" with a new key.
  for (const d of ['workflows', 'peers', 'cards']) fs.rmSync(path.join(s.root, d), { recursive: true, force: true })
  for (const f of ['settings.json', 'het-settings.json', 'grants.json']) fs.rmSync(path.join(s.root, f), { force: true })
  return s
}

function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of listFiles(dir)) out[f] = sha(fs.readFileSync(path.join(dir, f)))
  return out
}

// S2-SEC L2 / L3 / onboarding.json.
describe('backup security fixes (S2-SEC)', () => {
  it('L2: under peers/ only <fingerprint>.json is copied; subscription.json is listed as excluded with a reason', async () => {
    const s = populatedStore()
    fs.writeFileSync(
      path.join(s.root, 'peers', 'subscription.json'),
      JSON.stringify({ version: 1, folder: '/Users/someone/Library/Mobile Documents/friends', enabled: true, lastRefreshAt: null, ledger: {} })
    )
    fs.writeFileSync(path.join(s.root, 'peers', 'notes.json'), '{}')
    fs.writeFileSync(path.join(s.root, 'onboarding.json'), '{"version":1}')
    const { svc } = service({ storeRoot: s.root })
    const r = await svc.exportTo(tempDir('target'), { withoutModel: true })
    const files = listFiles(r.path!)
    const peerFiles = files.filter((f) => f.startsWith('lens/peers/'))
    expect(peerFiles.length).toBe(1)
    expect(peerFiles[0]).toMatch(/^lens\/peers\/[0-9a-f]{64}\.json$/)
    for (const f of files) expect(fs.readFileSync(path.join(r.path!, f), 'utf8')).not.toContain('Mobile Documents')
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(r.path!, 'manifest.json'), 'utf8')))
    expect(manifest.excluded).toEqual(
      expect.arrayContaining([
        { path: 'peers/subscription.json', reason: expect.stringContaining('绝对路径') },
        { path: 'onboarding.json', reason: '首次引导记录，按机器保存' }
      ])
    )
    // onboarding.json is documented once, not also as an unknown store entry.
    expect(manifest.excluded.filter((e) => e.path === 'onboarding.json')).toHaveLength(1)
    expect(manifest.skipped).toContainEqual({ path: 'lens/peers/notes.json', reason: expect.stringContaining('朋友记录') })
    expect(manifest.skipped.map((e) => e.path)).not.toContain('lens/peers/subscription.json')
  })

  it('L3: a peer record whose card issuer differs from the file name fingerprint is failed and writes nothing', async () => {
    const { dir } = await makeBackup()
    const f = listFiles(dir).find((p) => /^lens\/peers\/[0-9a-f]{64}\.json$/.test(p))!
    const wrongFp = 'ab'.repeat(32)
    const renamed = `lens/peers/${wrongFp}.json`
    fs.renameSync(path.join(dir, f), path.join(dir, renamed))
    rewriteManifest(dir, (m) => {
      m.files.find((x) => x.path === f)!.path = renamed
    })
    const fresh = tempDir('fresh')
    const { svc } = service({ storeRoot: fresh })
    const rep = await svc.restore((await svc.inspect(dir)).inspectionId!)
    expect(rep.peers).toMatchObject({ added: 0, failed: 1 })
    expect(rep.peers.items).toEqual([{ fingerprint: wrongFp, outcome: 'failed', detail: expect.stringContaining('卡片签名者与文件名不一致') }])
    expect(createPeerStore({ storeRoot: fresh }).list().peers).toHaveLength(0)
    expect(fs.existsSync(path.join(fresh, 'peers')) ? fs.readdirSync(path.join(fresh, 'peers')) : []).toEqual([])
  })
})

describe('S1-R3-SEC backup hardening', () => {
  it('L4: a copied (diverged / shadowing) workflow is re-stamped imported / import_file in EVERY version', async () => {
    const { source, dir } = await makeBackup()
    expect(createWorkflowStore(source.root).versions(source.workflowId).length).toBeGreaterThan(1)
    const fresh = populatedStoreFreshIdentity()
    // C21 shadowing guard: the Runtime observes the same id with different content → never restored under that id.
    const o = observed()
    const svc = createBackupService({
      storeRoot: fresh.root,
      runtimeRoot: () => runtimeRoot(),
      persomeBin: () => null,
      observedWorkflows: () => [{ ...o, steps: [{ order: 1, text: '完全不同的步骤' }] }]
    })
    const rep = await svc.restore((await svc.inspect(dir)).inspectionId!)
    expect(rep.workflows).toMatchObject({ imported: 1, restored: 0 })
    const store = createWorkflowStore(fresh.root)
    expect(store.latest(source.workflowId)).toBeNull()
    const [latest] = store.listLatest()
    expect(latest.id).toMatch(/^imp-/)
    const versions = store.versions(latest.id)
    expect(versions.length).toBeGreaterThan(1)
    for (const v of versions) {
      expect(v.provenance.kind, `v${v.version}`).toBe('imported')
      expect(v.provenance.original_id, `v${v.version}`).toBe(source.workflowId)
      expect(v.provenance.original_version, `v${v.version}`).toBe(v.version)
      expect(v.source.type, `v${v.version}`).toBe('import_file')
    }
  })

  it('L5: restore needs a main-side confirm (Cancel writes nothing); the confirm gets the sender', async () => {
    const { dir } = await makeBackup()
    const fresh = populatedStoreFreshIdentity()
    const { svc } = service({ storeRoot: fresh.root })
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
    const asks: unknown[] = []
    let answer = false
    registerBackupHandlers({ handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => handlers.set(ch, fn) } as never, svc, async () => dir, async (_summary, sender) => {
      asks.push(sender)
      return answer
    })
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({ sender: 'win' }, raw) as Promise<{ ok: boolean; data?: any; error?: any }>
    const ins = await call(BACKUP_CHANNELS.inspect)
    const no = await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId, confirm: true })
    expect(no.ok).toBe(false)
    expect(no.error.message).toMatch(/取消/)
    expect(createWorkflowStore(fresh.root).listLatest()).toHaveLength(0)
    answer = true
    const yes = await call(BACKUP_CHANNELS.restore, { inspectionId: ins.data.inspectionId, confirm: true })
    expect(yes).toMatchObject({ ok: true, data: { workflows: { imported: 1 } } })
    expect(asks).toEqual(['win', 'win'])
  })
})

describe('en: English UI text', () => {
  it('en: export / inspect errors read in English', async () => {
    setLocale('en')
    const s = populatedStore()
    const { svc } = service({ storeRoot: s.root })
    await expect(svc.exportTo('relative/dir', { withoutModel: true })).rejects.toThrow(/must be an absolute path/)
    await expect(svc.exportTo(path.join(s.root, 'cards'), { withoutModel: true })).rejects.toThrow(/inside the Navalia data folder/)
  })
})
