// C11: the broadcast weekly-letter draft (subs.ts letterDraft) and the per-friend letter
// (peers/service.ts) list ONLY accepted, doubly-verified, `letters`-visibility moments in the window.
// `private`, pending, out-of-window and locally tampered moments never appear. The user's own note is
// attached only when ticked (toggleNote), and is redacted like the rest of the broadcast draft.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMomentsService, type MomentsService } from '../../src/main/cloud/moments'
import type { MomentProposeArgs } from '../../src/main/cloud/moments-api'
import { MOMENTS_DIR } from '../../src/main/cloud/moments-store'
import { createSubsService } from '../../src/main/cloud/subs'
import { createPeersService } from '../../src/main/peers/service'
import type { RuntimeClient } from '../../src/main/runtime/client'
import { toggleNote } from '../../src/renderer/src/components/moments/momentsView'
import { startFakeServer, type FakeServer } from './helpers'
import { befriend, cleanupMoments, installMomentsRoutes, person, signIn, type MomentsServer, type Person } from './moments-helpers'

const roots: string[] = []
let server: FakeServer
let api: MomentsServer
let a: Person
let b: Person
let c: Person
const NOW = new Date('2026-11-05T02:00:00Z') // UTC window 2026-10-30 … 2026-11-05

const svc = (p: Person): MomentsService =>
  createMomentsService({ storeRoot: p.root, cloud: p.cloud!, getPublicIdentity: () => p.keys.getPublicIdentity(), sign: (m) => p.keys.sign(m), nativeConfirm: async () => true })

async function moment(from: Person, to: Person, over: Partial<MomentProposeArgs>, accept = true): Promise<string> {
  const sf = svc(from)
  const st = svc(to)
  const p = sf.proposePreview({ friendFingerprint: to.fingerprint, title: 't', start: '2026-11-01', end: '2026-11-01', place: null, note: '', visibility: 'letters', ...over })
  await sf.propose(p.previewId, null)
  if (accept) {
    await st.sync()
    await st.accept(st.acceptPreview(p.moment.moment_id).previewId, null)
    await sf.sync()
  }
  return p.moment.moment_id
}

const oss = (calls: string[]) => async (name: string): Promise<string> => {
  calls.push(name)
  if (name !== 'recent_activity') throw new Error('unexpected tool')
  return JSON.stringify({ count: 0, entries: [] })
}

let ids: Record<string, string>

beforeEach(async () => {
  server = await startFakeServer()
  api = installMomentsRoutes(server)
  a = person(roots, 'a')
  b = person(roots, 'b')
  c = person(roots, 'c')
  befriend(a, b)
  befriend(b, a)
  befriend(a, c)
  befriend(c, a)
  for (const p of [a, b, c]) await signIn(p, server, api)
  ids = {
    hill: await moment(a, b, { title: '一起去爬了香山' }),
    priv: await moment(a, b, { title: '私密晚饭', start: '2026-11-02', end: '2026-11-02', visibility: 'private' }),
    old: await moment(a, b, { title: '十月旧事', start: '2026-10-01', end: '2026-10-02' }),
    run: await moment(c, a, { title: '和C的跑步', start: '2026-11-03', end: '2026-11-03' }),
    pending: await moment(a, b, { title: '待确认的', start: '2026-11-04', end: '2026-11-04' }, false),
    span: await moment(a, b, { title: '跨周的旅行', start: '2026-10-28', end: '2026-10-31' }),
    bad: await moment(a, b, { title: '被篡改', start: '2026-11-04', end: '2026-11-04' })
  }
  // Tamper A's local copy of `bad` (keeps it well-formed, breaks the signature).
  const file = path.join(a.root, MOMENTS_DIR, `${ids.bad}.json`)
  const f = JSON.parse(fs.readFileSync(file, 'utf8'))
  f.moment = JSON.stringify({ ...JSON.parse(f.moment), visibility: 'letters', title: '被篡改了' })
  fs.writeFileSync(file, JSON.stringify(f))
  svc(a).setNote(ids.hill, '「那天最记得的一个细节是？」风很大，记得发邮件到 me@example.com')
})

afterEach(async () => {
  await server.close()
  cleanupMoments(roots)
})

describe('C11 broadcast draft (subscribers)', () => {
  it('only accepted + letters + in-window + verified; notes off by default, toggled in, redacted', async () => {
    const calls: string[] = []
    const subs = createSubsService({
      storeRoot: a.root,
      cloud: a.cloud!,
      getPublicIdentity: () => a.keys.getPublicIdentity(),
      sign: (m) => a.keys.sign(m),
      ossTool: oss(calls),
      now: () => NOW
    })
    const d = await subs.letterDraft({ timezone: 'UTC' })
    const section = d.markdown.split('## 这周和朋友的共同经历')[1].split('\n## ')[0]
    expect(section).toContain('「一起去爬了香山」 · 和 Name-b（双方签名确认）')
    expect(section).toContain('「和C的跑步」 · 和 Name-c')
    expect(section).toContain('2026-10-28 至 2026-10-31 · 「跨周的旅行」')
    for (const x of ['私密晚饭', '十月旧事', '待确认的', '被篡改']) expect(d.markdown).not.toContain(x)
    expect(d.markdown).not.toContain('风很大') // the note is not included by default
    expect(d.moments!.map((m) => m.title).sort()).toEqual(['一起去爬了香山', '和C的跑步', '跨周的旅行'].sort())
    const hill = d.moments!.find((m) => m.momentId === ids.hill)!
    expect(hill.line && d.markdown.split('\n')).toContain(hill.line)
    expect(hill.noteLine).toContain('风很大')
    expect(hill.noteLine).not.toContain('me@example.com') // redactForCloud
    expect(d.moments!.find((m) => m.momentId === ids.run)!.noteLine).toBeNull()
    const withNote = toggleNote(d.markdown, hill.line, hill.noteLine, true)!
    const lines = withNote.split('\n')
    expect(lines[lines.indexOf(hill.line!) + 1]).toBe(hill.noteLine)
    expect(toggleNote(withNote, hill.line, hill.noteLine, true)).toBe(withNote) // idempotent
    expect(toggleNote(withNote, hill.line, hill.noteLine, false)).toBe(d.markdown)
    expect(toggleNote(d.markdown.replace(hill.line!, '- 改过'), hill.line, hill.noteLine, true)).toBeNull()
    expect(calls).toEqual(['recent_activity'])
  })
})

describe('C11 per-friend letter (Peers)', () => {
  it('lists only signed `letters` moments with THIS friend; no keyword search', async () => {
    const calls: string[] = []
    const peers = createPeersService({
      storeRoot: a.root,
      now: () => NOW,
      runtime: () => ({ modelGraph: async () => ({ model: null }) }) as unknown as RuntimeClient,
      ossTool: oss(calls),
      saveDialog: async () => null,
      openDialog: async () => null
    })
    const d = await peers.letterDraft(b.fingerprint, 'UTC')
    const section = d.markdown.split('## 这周和你的共同经历')[1].split('\n## ')[0]
    expect(section).toContain('- 2026-11-01 · 「一起去爬了香山」（双方签名确认）')
    expect(section).toContain('「跨周的旅行」')
    for (const x of ['和C的跑步', '私密晚饭', '十月旧事', '待确认的', '被篡改', '风很大']) expect(d.markdown).not.toContain(x)
    expect(d.counts.experiences).toBe(2)
    expect(calls).toEqual(['recent_activity'])
    const toC = await peers.letterDraft(c.fingerprint, 'UTC')
    expect(toC.markdown).toContain('「和C的跑步」')
    expect(toC.markdown).not.toContain('香山')
  })
})
