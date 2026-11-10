// S2-09 local subscription folder: manual refresh, offline verify, sha256 ledger, caps, no symlinks.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { PEERS_CHANNELS, type SubscriptionRefreshReport, type SubscriptionStatus, type PeerList } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import type { PeersDeps } from '../../src/main/peers/service'
import { MAX_SUB_FILES, validateFolder } from '../../src/main/peers/subscription'
import type { RuntimeClient } from '../../src/main/runtime/client'
import { signSkill } from '../../src/main/skillshare/package'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { createWorkflowService } from '../../src/main/workflows/service'
import type { LensResult } from '../../src/shared/types'
import { subscriptionRows, subscriptionState, subscriptionSummary } from '../../src/renderer/src/components/peers/peersView'
import { FIXTURE_RUNTIME } from '../workflows/helpers'
import { friend, tempDir, text, userGraph, type Friend } from './fixtures'

// Heavily Chinese UI assertions: run this file in zh (an English check is at the end).
beforeEach(() => setLocale('zh'))
const roots: string[] = []
afterEach(() => {
  setLocale('en')
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

type Handler = (event: unknown, raw: unknown) => Promise<LensResult<unknown>>

function harness(opts: { storeRoot?: string; pick?: () => string | null } = {}) {
  const storeRoot = opts.storeRoot ?? tempDir('sub-store')
  const runtimeRoot = tempDir('sub-runtime') // empty Runtime: no observed skills
  const folder = tempDir('sub-folder')
  roots.push(storeRoot, runtimeRoot, folder)
  let picked: string | null = folder
  const deps: PeersDeps = {
    storeRoot,
    runtimeRoot: () => runtimeRoot,
    now: () => new Date('2026-11-05T02:00:00Z'),
    runtime: () => ({ modelGraph: async () => userGraph() }) as unknown as RuntimeClient,
    ossTool: async () => '{}',
    saveDialog: async () => null,
    openDialog: async () => null,
    openDirectoryDialog: async () => (opts.pick ? opts.pick() : picked)
  }
  const register = () => {
    const handlers = new Map<string, Handler>()
    registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
    return <T>(ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<LensResult<T>>
  }
  const call = register()
  return {
    storeRoot,
    runtimeRoot,
    folder,
    deps,
    call,
    register,
    setPicked: (p: string | null) => {
      picked = p
    },
    async refresh(): Promise<SubscriptionRefreshReport> {
      const r = await call<SubscriptionRefreshReport>(PEERS_CHANNELS.subRefresh)
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
      return r.data
    }
  }
}

function data<T>(r: LensResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

const weekly = () => structuredClone(readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!)

function skillText(f: Friend): string {
  return signSkill(weekly(), f.keys, () => new Date('2026-11-04T10:00:00.000Z')).text
}

function tamperedCard(f: Friend): string {
  const c = JSON.parse(text(f.card()))
  c.card.content.front.summary = '被改过的概述'
  return JSON.stringify(c)
}

function tamperedSkill(f: Friend): string {
  const p = JSON.parse(skillText(f))
  p.payload.workflow.title = `${p.payload.workflow.title}!`
  return JSON.stringify(p)
}

const byName = (r: SubscriptionRefreshReport) => Object.fromEntries(r.files.map((f) => [f.name, f]))

describe('subscription folder: config', () => {
  it('is off by default; refresh refuses while nothing is configured or after 停用', async () => {
    const h = harness()
    const s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s).toMatchObject({ enabled: false, folder: null, folderProblem: null, ledgerSize: 0, lastRefreshAt: null })
    expect(subscriptionState(s).text).toBe('未启用')
    const r = await h.call(PEERS_CHANNELS.subRefresh)
    expect(r).toMatchObject({ ok: false, error: { code: 'schema', message: expect.stringContaining('未启用') } })
    // Reading status never creates the config file.
    expect(fs.existsSync(path.join(h.storeRoot, 'peers', 'subscription.json'))).toBe(false)

    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subChoose))).toMatchObject({ enabled: true, folder: h.folder })
    const off = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subDisable))
    expect(off).toMatchObject({ enabled: false, folder: h.folder })
    expect(subscriptionState(off).text).toBe('已停用')
    expect((await h.call(PEERS_CHANNELS.subRefresh)).ok).toBe(false)
    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subEnable))).toMatchObject({ enabled: true })
    expect((await h.call(PEERS_CHANNELS.subRefresh)).ok).toBe(true)
  })

  it('validates the folder: absolute, exists, directory, not inside the Navalia Store', async () => {
    const h = harness()
    const file = path.join(h.folder, 'f.txt')
    fs.writeFileSync(file, 'x')
    expect(validateFolder('relative/dir', h.storeRoot)).toMatchObject({ ok: false, problem: expect.stringContaining('绝对路径') })
    expect(validateFolder(path.join(h.folder, 'missing'), h.storeRoot)).toMatchObject({ ok: false, problem: expect.stringContaining('不存在') })
    expect(validateFolder(file, h.storeRoot)).toMatchObject({ ok: false, problem: expect.stringContaining('不是文件夹') })
    expect(validateFolder(h.storeRoot, h.storeRoot)).toMatchObject({ ok: false, problem: expect.stringContaining('Navalia Store') })
    const inner = path.join(h.storeRoot, 'peers')
    fs.mkdirSync(inner, { recursive: true })
    expect(validateFolder(inner, h.storeRoot)).toMatchObject({ ok: false, problem: expect.stringContaining('Navalia Store') })
    // A symlink to a folder inside the store is resolved and refused too.
    const link = path.join(h.folder, 'store-link')
    fs.symlinkSync(inner, link)
    expect(validateFolder(link, h.storeRoot)).toMatchObject({ ok: false })
    expect(validateFolder(h.folder, h.storeRoot)).toMatchObject({ ok: true })

    h.setPicked(inner)
    expect(await h.call(PEERS_CHANNELS.subChoose)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    h.setPicked(null)
    expect(await h.call(PEERS_CHANNELS.subChoose)).toEqual({ ok: true, data: null })
    // Rejects payloads (zod).
    expect((await h.call(PEERS_CHANNELS.subRefresh, { folder: '/' })).ok).toBe(false)
    expect((await h.call(PEERS_CHANNELS.subChoose, { path: '/' })).ok).toBe(false)

    // Folder removed after it was chosen: status reports it, refresh and enable refuse.
    const gone = tempDir('sub-gone')
    h.setPicked(gone)
    data(await h.call(PEERS_CHANNELS.subChoose))
    fs.rmSync(gone, { recursive: true })
    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).folderProblem).toContain('不存在')
    expect(await h.call(PEERS_CHANNELS.subRefresh)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect((await h.call(PEERS_CHANNELS.subEnable)).ok).toBe(false)
  })
})

describe('subscription folder: refresh', () => {
  it('imports a valid card + skill, rejects tampered ones, skips oversize / symlink / non-regular, then dedupes by sha256', async () => {
    const h = harness()
    const alice = friend('sub-alice')
    const bob = friend('sub-bob')
    const outside = tempDir('sub-outside')
    roots.push(alice.root, bob.root, outside)
    data(await h.call(PEERS_CHANNELS.subChoose))

    const w = (name: string, body: string | Buffer) => fs.writeFileSync(path.join(h.folder, name), body)
    w('alice.navaliacard', text(alice.card()))
    w('weekly.navaliaskill', skillText(alice))
    w('bob-tampered.navaliacard', tamperedCard(bob))
    w('tampered.navaliaskill', tamperedSkill(bob))
    w('huge.navaliacard', Buffer.alloc(2_000_001, 0x20))
    w('notes.txt', 'not a card')
    w('._alice.navaliacard', 'AppleDouble junk')
    w('.ghost.navaliacard.icloud', 'placeholder')
    fs.writeFileSync(path.join(outside, 'bob.navaliacard'), text(bob.card()))
    fs.symlinkSync(path.join(outside, 'bob.navaliacard'), path.join(h.folder, 'link.navaliacard'))
    fs.mkdirSync(path.join(h.folder, 'dir.navaliacard'))
    fs.writeFileSync(path.join(h.folder, 'dir.navaliacard', 'inner.navaliacard'), text(bob.card())) // non-recursive: never read

    const r1 = await h.refresh()
    const f1 = byName(r1)
    expect(f1['alice.navaliacard']).toMatchObject({ kind: 'card', outcome: 'added', reason: null, detail: 'Alice', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(f1['weekly.navaliaskill']).toMatchObject({ kind: 'skill', outcome: 'added', detail: expect.stringMatching(/^shr-[0-9a-f]{12}$/) })
    expect(f1['bob-tampered.navaliacard']).toMatchObject({ outcome: 'rejected', reason: 'tampered' })
    expect(f1['tampered.navaliaskill']).toMatchObject({ outcome: 'rejected', reason: 'skill', detail: expect.stringContaining('签名校验失败') })
    expect(f1['huge.navaliacard']).toMatchObject({ outcome: 'skipped', reason: 'too_large', sha256: null })
    expect(f1['link.navaliacard']).toMatchObject({ outcome: 'skipped', reason: 'symlink', sha256: null })
    expect(f1['dir.navaliacard']).toMatchObject({ outcome: 'skipped', reason: 'not_regular' })
    expect(f1['ghost.navaliacard']).toMatchObject({ outcome: 'skipped', reason: 'not_downloaded' })
    expect(f1['inner.navaliacard']).toBeUndefined()
    expect(f1['._alice.navaliacard']).toBeUndefined()
    expect(r1.ignored).toBe(2) // notes.txt, ._alice.navaliacard
    expect(r1.counts).toMatchObject({ added: 2, rejected: 2, skipped: 4, duplicate: 0 })
    expect(subscriptionSummary(r1)).toContain('新增 2')
    expect(subscriptionRows(r1).find((x) => x.name === 'link.navaliacard')!.note).toContain('符号链接')

    // Peers: only Alice (Bob only reachable via symlink / tampered / subfolder).
    const list = data(await h.call<PeerList>(PEERS_CHANNELS.list))
    expect(list.peers.map((p) => p.fingerprint)).toEqual([alice.fingerprint])
    // Skill: stored with shared provenance + signer fingerprint (same path as Playbook import).
    const wf = createWorkflowService({ storeRoot: h.storeRoot, runtimeRoot: () => h.runtimeRoot })
    const shared = (await wf.catalog()).workflows.filter((x) => x.provenance.kind === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0].id).toBe(f1['weekly.navaliaskill'].detail)
    expect(shared[0].provenance).toMatchObject({ signer_fingerprint: alice.fingerprint, original_id: 'rt-weekly-report', from: 'weekly.navaliaskill' })

    // Ledger persisted, owner-only.
    const cfgFile = path.join(h.storeRoot, 'peers', 'subscription.json')
    expect(fs.statSync(cfgFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(cfgFile)).mode & 0o777).toBe(0o700)
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    expect(Object.keys(cfg.ledger).sort()).toEqual([f1['alice.navaliacard'].sha256, f1['weekly.navaliaskill'].sha256].sort())
    expect(cfg.lastRefreshAt).toBe('2026-11-05T02:00:00.000Z')
    // The ledger never stores file contents.
    expect(fs.readFileSync(cfgFile, 'utf8')).not.toContain('signature')

    // Re-run with a fresh service (ledger read from disk) + a renamed copy of the same card.
    w('alice-copy.navaliacard', text(JSON.parse(fs.readFileSync(path.join(h.folder, 'alice.navaliacard'), 'utf8'))))
    const call2 = h.register()
    const r2 = data(await call2<SubscriptionRefreshReport>(PEERS_CHANNELS.subRefresh))
    const f2 = byName(r2)
    expect(f2['alice.navaliacard'].outcome).toBe('duplicate')
    expect(f2['alice-copy.navaliacard'].outcome).toBe('duplicate')
    expect(f2['weekly.navaliaskill'].outcome).toBe('duplicate')
    expect(f2['bob-tampered.navaliacard'].outcome).toBe('rejected') // rejections are not ledgered: still reported
    expect(subscriptionRows(r2).find((x) => x.name === 'alice.navaliacard')!.label).toBe('重复跳过')
    // Peer not re-imported (no reimported_same event added).
    const events = data(await call2<{ events: unknown[] }>(PEERS_CHANNELS.get, { fingerprint: alice.fingerprint })).events
    expect(events).toHaveLength(1)

    // A newer card from Alice → updated.
    w('alice-2.navaliacard', text(alice.card({ issuedAt: '2026-11-04T00:00:00.000Z', summary: '换了方向' })))
    const r3 = await h.refresh()
    expect(byName(r3)['alice-2.navaliacard']).toMatchObject({ outcome: 'updated' })
  })

  it('a skill file whose content already exists in the Navalia Store is a duplicate, and is ledgered', async () => {
    const h = harness()
    const alice = friend('sub-dup')
    roots.push(alice.root)
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await h.call(PEERS_CHANNELS.importText, { text: text(alice.card()) })) // signer must be a friend (S2-SEC M1)
    fs.writeFileSync(path.join(h.folder, 'a.navaliaskill'), skillText(alice))
    // Same workflow, re-signed later → different bytes, same content.
    fs.writeFileSync(path.join(h.folder, 'b.navaliaskill'), signSkill(weekly(), alice.keys, () => new Date('2026-11-05T00:00:00.000Z')).text)
    const r = await h.refresh()
    expect(byName(r)['a.navaliaskill'].outcome).toBe('added')
    expect(byName(r)['b.navaliaskill']).toMatchObject({ outcome: 'duplicate', reason: 'skill' })
    expect(subscriptionRows(r).find((x) => x.name === 'b.navaliaskill')!.note).toContain('已经在本机')
    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).ledgerSize).toBe(2)
  })

  it('refuses a card signed with this Navalia Store’s own key (self)', async () => {
    const me = friend('sub-me')
    roots.push(me.root)
    const h = harness({ storeRoot: me.root })
    data(await h.call(PEERS_CHANNELS.subChoose))
    fs.writeFileSync(path.join(h.folder, 'me.navaliacard'), text(me.card()))
    const r = await h.refresh()
    expect(r.files[0]).toMatchObject({ outcome: 'rejected', reason: 'self' })
    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).ledgerSize).toBe(0)
  })

  it('never opens a FIFO named like a card (would block)', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    execFileSync('mkfifo', [path.join(h.folder, 'pipe.navaliacard')])
    const r = await h.refresh()
    expect(r.files[0]).toMatchObject({ name: 'pipe.navaliacard', outcome: 'skipped', reason: 'not_regular' })
  })

  it('caps the number of files handled per refresh', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    for (let i = 0; i < MAX_SUB_FILES + 3; i++) fs.writeFileSync(path.join(h.folder, `c${String(i).padStart(4, '0')}.navaliacard`), '{}')
    const r = await h.refresh()
    expect(r.counts.rejected).toBe(MAX_SUB_FILES)
    expect(r.files.filter((f) => f.reason === 'count_cap')).toHaveLength(3)
  })

  it('a 停用 during a refresh is not overwritten when the refresh saves its ledger', async () => {
    const h = harness()
    const alice = friend('sub-race')
    roots.push(alice.root)
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await h.call(PEERS_CHANNELS.importText, { text: text(alice.card()) }))
    fs.writeFileSync(path.join(h.folder, 'a.navaliaskill'), skillText(alice))
    const pending = h.refresh()
    data(await h.call(PEERS_CHANNELS.subDisable))
    const r = await pending
    expect(r.counts.added).toBe(1)
    const s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s).toMatchObject({ enabled: false, ledgerSize: 1 })
  })

  it('a corrupt config is treated as not configured', async () => {
    const h = harness()
    fs.mkdirSync(path.join(h.storeRoot, 'peers'), { recursive: true })
    fs.writeFileSync(path.join(h.storeRoot, 'peers', 'subscription.json'), '{"version":1,"enabled":true')
    const s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s).toMatchObject({ enabled: false, folder: null, folderProblem: expect.stringContaining('无法读取') })
    expect((await h.call(PEERS_CHANNELS.subRefresh)).ok).toBe(false)
  })

  // S2-SEC M1: the folder feeds the Broker (search_workflows / get_workflow), so only friends' skills enter.
  describe('skills only from friends (S2-SEC M1)', () => {
    it('skips a validly signed skill from a key not in the Peers list, without ledgering it; imports it after the friend is added', async () => {
      const h = harness()
      const mallory = friend('sub-mallory')
      roots.push(mallory.root)
      data(await h.call(PEERS_CHANNELS.subChoose))
      fs.writeFileSync(path.join(h.folder, 'm.navaliaskill'), skillText(mallory))
      const r1 = await h.refresh()
      expect(byName(r1)['m.navaliaskill']).toMatchObject({ kind: 'skill', outcome: 'skipped', reason: 'unknown_signer', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
      expect(subscriptionRows(r1)[0].note).toContain('签名者不在朋友列表，未导入')
      expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).ledgerSize).toBe(0)
      const wf = createWorkflowService({ storeRoot: h.storeRoot, runtimeRoot: () => h.runtimeRoot })
      expect((await wf.catalog()).workflows.filter((w) => w.provenance.kind === 'shared')).toHaveLength(0)

      // Same file again after the user adds the friend: not a ledger duplicate, imports now.
      data(await h.call(PEERS_CHANNELS.importText, { text: text(mallory.card()) }))
      const r2 = await h.refresh()
      expect(byName(r2)['m.navaliaskill']).toMatchObject({ outcome: 'added' })
      expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).ledgerSize).toBe(1)
    })

    it('imports a skill whose signer is already a friend', async () => {
      const h = harness()
      const alice = friend('sub-known')
      roots.push(alice.root)
      data(await h.call(PEERS_CHANNELS.subChoose))
      data(await h.call(PEERS_CHANNELS.importText, { text: text(alice.card()) }))
      fs.writeFileSync(path.join(h.folder, 'a.navaliaskill'), skillText(alice))
      const r = await h.refresh()
      expect(byName(r)['a.navaliaskill']).toMatchObject({ outcome: 'added', reason: null })
    })

    it('a friend card and their skill dropped together import in the same refresh (cards first, regardless of name order)', async () => {
      const h = harness()
      const alice = friend('sub-together')
      roots.push(alice.root)
      data(await h.call(PEERS_CHANNELS.subChoose))
      fs.writeFileSync(path.join(h.folder, 'a-skill.navaliaskill'), skillText(alice)) // sorts before the card by name
      fs.writeFileSync(path.join(h.folder, 'z-alice.navaliacard'), text(alice.card()))
      const r = await h.refresh()
      expect(r.files.map((f) => f.name)).toEqual(['z-alice.navaliacard', 'a-skill.navaliaskill'])
      expect(byName(r)['z-alice.navaliacard'].outcome).toBe('added')
      expect(byName(r)['a-skill.navaliaskill'].outcome).toBe('added')
      expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).ledgerSize).toBe(2)
    })

    it('a tampered skill from an unknown signer is still reported as rejected (verify first)', async () => {
      const h = harness()
      const eve = friend('sub-eve')
      roots.push(eve.root)
      data(await h.call(PEERS_CHANNELS.subChoose))
      fs.writeFileSync(path.join(h.folder, 't.navaliaskill'), tamperedSkill(eve))
      const r = await h.refresh()
      expect(r.files[0]).toMatchObject({ outcome: 'rejected', reason: 'skill' })
    })
  })
})

describe('subscription view-model in English (default locale)', () => {
  it('state, summary and folder problems read in English', () => {
    setLocale('en')
    expect(subscriptionState(null).text).toBe('Not enabled')
    expect(subscriptionSummary({ folder: '/x', scannedAt: '2026-11-05T00:00:00Z', files: [], counts: { added: 0, updated: 0, unchanged: 0, older_version: 0, duplicate: 0, rejected: 0, skipped: 0 }, ignored: 0 }, true)).toBe('No new files')
    expect(validateFolder('relative/dir', '/tmp/none')).toMatchObject({ ok: false, problem: 'Folder path must be absolute' })
  })
})
