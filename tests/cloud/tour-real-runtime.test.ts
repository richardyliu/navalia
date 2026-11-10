// Opt-in walkthrough (README step 3): the real Lens main-process services against a local `cloud/`
// in all-mock mode (LLM, STT, mail outbox), reading the user's REAL Runtime and ~/.claude
// READ-ONLY for context. Nothing is written to the Runtime (no remember / import). Temp identity,
// temp Lens Store, temp cloud DB; everything leaves the machine only to 127.0.0.1.
//   LENS_TOUR=1 npx vitest run tests/cloud/tour-real-runtime.test.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatService } from '../../src/main/cloud/chat'
import { createMeetingsService } from '../../src/main/cloud/meetings'
import { createMicArm } from '../../src/main/cloud/meetings-mic-gate'
import { createMomentsService } from '../../src/main/cloud/moments'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { createSubsService } from '../../src/main/cloud/subs'
import { writeCardFile } from '../../src/main/identity/card'
import { PersomeMcp } from '../../src/main/mcp/client'
import { knownRuntimeSecrets } from '../../src/main/mcp/known-secrets'
import { createPeerStore } from '../../src/main/peers/store'
import { locate } from '../../src/main/runtime/paths'
import { storePaths } from '../../src/main/store/paths'
import { createCloudExtractService } from '../../src/main/workflows/cloud-extract'
import { createWorkflowService } from '../../src/main/workflows/service'
import { createSessionSource } from '../../src/main/workflows/sessions'
import { fakeBox } from './helpers'
import { cardTextOf, cleanupSubs, person, subsTemp, type Person } from './subs-helpers'

const ON = process.env.LENS_TOUR === '1'
const OUT = path.resolve('docs/test-evidence/S1FULL-TOUR')
const roots: string[] = []
let child: ChildProcess
let origin = ''
let outbox = ''
let serverOut = ''
let mcp: PersomeMcp | null = null
const report: Record<string, unknown> = {}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function cloudFor(p: Person): Promise<CloudService> {
  const c = createCloudService({ storeRoot: p.root, box: fakeBox(), sign: (m) => p.keys.sign(m), getPublicIdentity: () => p.keys.getPublicIdentity(), allowInsecureLoopback: true, nativeConfirm: async () => true })
  await c.configure({ enabled: true, baseUrl: origin, confirm: true })
  await c.signIn()
  return c
}

/** Read-only MCP tools only; anything else (remember, correct_memory, …) is refused. */
const READ_ONLY = new Set(['search', 'search_captures', 'recent_activity', 'behavior_patterns', 'entity_graph', 'read_memory', 'list_memories', 'current_context'])
async function ossTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!READ_ONLY.has(name)) throw new Error(`tour refuses write tool ${name}`)
  return mcp!.callTool(name, args)
}

beforeAll(async () => {
  if (!ON) return
  const loc = locate()
  if (!loc.bin) throw new Error('persome CLI not found')
  mcp = new PersomeMcp(loc.bin, loc.root)
  const dir = subsTemp(roots, 'tour-server')
  outbox = path.join(dir, 'outbox')
  fs.mkdirSync(outbox)
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'),
      CLOUD_AUDIO_DIR: path.join(dir, 'audio'),
      CLOUD_PUBLIC_ORIGIN: origin,
      CLOUD_LLM_MODE: 'mock',
      CLOUD_STT_MODE: 'mock',
      CLOUD_MAIL_MODE: 'outbox',
      CLOUD_MAIL_FROM: 'letters@example.test',
      CLOUD_MAIL_OUTBOX_DIR: outbox
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 40_000)

afterAll(async () => {
  if (!ON) return
  mcp?.close()
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'tour.json'), `${JSON.stringify(report, null, 2)}\n`)
  cleanupSubs(roots)
})

describe.skipIf(!ON)('README step 3 walkthrough (real Runtime read-only, local mock cloud)', () => {
  it('chat · wechat · letter+unsubscribe · meeting · moments · workflow extract · delete account', { timeout: 240_000 }, async () => {
    const known = (): string[] => knownRuntimeSecrets(locate().root)
    const me = person(roots, 'tour-me')
    const friend = person(roots, 'tour-friend')
    writeCardFile(storePaths(me.root), me.card({ name: '我' }))
    createPeerStore({ storeRoot: me.root }).importText(cardTextOf(friend.card({ name: '朋友' })))
    createPeerStore({ storeRoot: friend.root }).importText(cardTextOf(me.card({ name: '我' })))
    const cloud = await cloudFor(me)
    report.signIn = cloud.status()

    // 1. Chat on REAL context (preview → send to the local mock LLM). No write-back.
    const chat = createChatService({ storeRoot: me.root, cloud, ossTool, knownSecrets: known })
    const pv = await chat.preview({ question: '我这周在做什么' })
    const r = await chat.send({ previewId: pv.previewId, includeIds: pv.items.map((i) => i.id) }, null)
    await chat.settled(r.streamId)
    const ans = chat.get(r.conversationId).messages[1]
    report.chat = {
      previewItems: pv.items.length,
      previewChars: pv.items.reduce((n, i) => n + i.text.length, 0),
      kinds: pv.items.reduce<Record<string, number>>((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {}),
      firstTitles: pv.items.slice(0, 5).map((i) => i.title),
      warnings: (pv as unknown as { warnings?: string[] }).warnings ?? [],
      answer: ans.role === 'assistant' ? ans.content : null,
      citations: ans.role === 'assistant' ? ans.citations.map((c) => c.id) : []
    }
    expect(ans.role === 'assistant' && ans.status).toBe('complete')

    // 2. WeChat group preview (real captures, read-only; not sent).
    const wx = await chat.wechatPreview({})
    report.wechat = { items: wx.items.length, groups: [...new Set(wx.items.map((i) => i.title))].slice(0, 8), warnings: (wx as unknown as { warnings?: string[] }).warnings ?? [] }

    // 3. Weekly letter draft from REAL recent activity (redacted) → publish to an outbox subscriber → unsubscribe.
    const subs = createSubsService({ storeRoot: me.root, cloud, getPublicIdentity: () => me.keys.getPublicIdentity(), sign: (m) => me.keys.sign(m), ossTool, knownSecrets: known, nativeConfirm: async () => true })
    const draft = await subs.letterDraft({ timezone: 'America/Los_Angeles' })
    const reader = 'tour-reader@example.test'
    await fetch(`${origin}/v1/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher: me.fingerprint, email: reader }) })
    await new Promise((res) => setTimeout(res, 800))
    const mails = (): string[] => fs.readdirSync(outbox).sort().map((f) => fs.readFileSync(path.join(outbox, f), 'utf8'))
    // Quoted-printable: drop soft breaks, decode =XX, then match the token (same as e2e-subs-real-server).
    const qp = (t: string): string => {
      const soft = t.replace(/=\r?\n/g, '').replace(/%/g, '%25').replace(/=([0-9A-F]{2})/g, '%$1')
      try {
        return decodeURIComponent(soft)
      } catch {
        return soft
      }
    }
    const token = /\/v1\/subscribe\/confirm\?token=([A-Za-z0-9_-]+)/.exec(qp(mails()[0] ?? ''))?.[1] ?? ''
    expect(token).not.toBe('')
    await fetch(`${origin}/v1/subscribe/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` })
    const lp = subs.letterPreview({ title: draft.title, markdown: draft.markdown, week: draft.week })
    const sent = await subs.letterPublish(lp.previewId, null)
    await new Promise((res) => setTimeout(res, 1500))
    const letter = mails()[1] ?? ''
    const unsub = /^List-Unsubscribe:\s*<([^>]+)>/m.exec(letter.replace(/\r?\n[ \t]+/g, ' '))?.[1] ?? ''
    const oneClick = unsub ? (await fetch(unsub, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status : null
    const lp2 = subs.letterPreview({ title: `${draft.title}（第二封）`, markdown: '退订后不应收到。', week: draft.week })
    const sent2 = await subs.letterPublish(lp2.previewId, null)
    report.letter = {
      draftChars: draft.markdown.length,
      draftWarnings: draft.warnings,
      draftHead: draft.markdown.split('\n').slice(0, 12),
      recipients: sent.recipients,
      mailsInOutbox: mails().length,
      hasListUnsubscribe: Boolean(unsub),
      hasOneClickHeader: /List-Unsubscribe-Post: List-Unsubscribe=One-Click/.test(letter),
      trackingPixel: /<img/i.test(letter),
      oneClickStatus: oneClick,
      recipientsAfterUnsubscribe: sent2.recipients
    }
    expect(sent.recipients).toBe(1)
    expect(sent2.recipients).toBe(0)

    // 4. Meeting: consent → 2 × 30 s synthetic chunks → mock transcript → Markdown preview → delete (no Runtime import).
    const micArm = createMicArm()
    const meet = createMeetingsService({ storeRoot: me.root, cloud, micArm, nativeConfirm: async () => true, askForMediaAccess: async () => true, runtimeRoot: () => path.join(me.root, 'no-runtime'), persomeBin: () => null, knownSecrets: known, timeZone: 'America/Los_Angeles', pollInitialMs: 50, pollMaxMs: 200, pollMaxAttempts: 200 })
    const st = await meet.start({ title: '导览会议', participantsInformed: true, languageHints: ['zh'] })
    for (const seq of [0, 1]) meet.chunk({ meetingId: st.meetingId, seq, mime: 'audio/webm;codecs=opus', durationMs: 30_000, data: new Uint8Array(randomBytes(32_000)) })
    meet.stop({ meetingId: st.meetingId, chunks: 2 })
    await meet.idle(st.meetingId)
    const md = meet.markdownPreview(st.meetingId)
    const del = await meet.delete({ meetingId: st.meetingId })
    report.meeting = { status: meet.list().length === 0 ? 'deleted' : 'still listed', markdownHead: md.markdown.split('\n').slice(0, 8), delete: del }

    // 5. Shared moment with a (temp) friend → accepted → appears in my letter draft.
    const fCloud = await cloudFor(friend)
    const mine = createMomentsService({ storeRoot: me.root, cloud, getPublicIdentity: () => me.keys.getPublicIdentity(), sign: (m) => me.keys.sign(m), nativeConfirm: async () => true })
    const theirs = createMomentsService({ storeRoot: friend.root, cloud: fCloud, getPublicIdentity: () => friend.keys.getPublicIdentity(), sign: (m) => friend.keys.sign(m), nativeConfirm: async () => true })
    const today = new Date().toISOString().slice(0, 10)
    const prop = await mine.propose(mine.proposePreview({ friendFingerprint: friend.fingerprint, title: '导览：一起测试 Lens 云端', start: today, end: today, place: null, note: '', visibility: 'letters' }).previewId, null)
    await theirs.sync()
    await theirs.accept(theirs.acceptPreview(prop.momentId).previewId, null)
    const synced = await mine.sync()
    const draft2 = await subs.letterDraft({ timezone: 'America/Los_Angeles' })
    report.moments = { accepted: synced.accepted.map((m) => m.title), inLetter: draft2.markdown.includes('导览：一起测试 Lens 云端') }

    // 6. Workflow extraction from the newest REAL Claude Code session (read-only) → draft only (temp store).
    const home = os.homedir()
    const wf = createCloudExtractService({
      workflows: createWorkflowService({ storeRoot: me.root, runtimeRoot: () => path.join(me.root, 'no-runtime') }),
      cloud,
      sessions: createSessionSource({ claudeRoot: path.join(home, '.claude', 'projects'), codexRoot: fs.existsSync(path.join(home, '.codex')) ? path.join(home, '.codex', 'sessions') : null }),
      sources: { claudeCode: true, codex: fs.existsSync(path.join(home, '.codex')) },
      knownSecrets: known
    })
    const sess = wf.sessions().sessions
    if (sess.length) {
      const wp = wf.preview(sess[0].key)
      const run = await wf.run(wp.previewId, wp.items.slice(0, 3).map((i) => i.id))
      report.workflow = { sessions: sess.length, previewItems: wp.items.length, draftTitle: run.draft.title, steps: run.draft.steps.map((s) => ({ title: s.title, cites: s.cites })) }
    } else report.workflow = { sessions: 0 }

    // 7. Right to deletion.
    await cloud.deleteAccount()
    report.deleteAccount = cloud.status()
    expect(cloud.status().signedIn).toBe(false)

    // Nothing private in the server's log.
    const leaks = [reader, '导览会议', '导览：一起测试', ...pv.items.slice(0, 3).map((i) => i.text.slice(0, 16))].filter((s) => s && serverOut.includes(s))
    report.serverLogLeaks = leaks
    expect(leaks).toEqual([])
  })
})
