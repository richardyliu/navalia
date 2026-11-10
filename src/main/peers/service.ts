// Peers service: local Peers list + read-only overlap suggestions + weekly letter draft.
// No network of its own: Runtime access goes only through the injected S1Deps
// (`runtime()` = loopback REST, `ossTool` = local stdio MCP), both read-only here.
import fs from 'node:fs/promises'
import { tr } from '../../shared/i18n'
import type { MemorySearchHit, ModelGraphResponse } from '../../shared/types'
import type { S1Deps } from '../s1/deps'
import type { LetterDraft, PeerDetail, PeerImportResult, PeerList, PeerSuggestions, SharedMoments } from './api'
import { addDays, buildLetter, letterWindow, peerName } from './letter'
import { createMomentsStore, letterMoments } from '../cloud/moments-store'
import { createPeerStore, MAX_CARD_BYTES, type PeerStore } from './store'
import { createSubscription, type Subscription } from './subscription'
import { createSubscriptionScheduler, type SubscriptionScheduler, type Timers } from './subscription-scheduler'
import { createSkillShare, type SkillShare } from '../skillshare/service'
import { createWorkflowService } from '../workflows/service'
import { redactForDisplay } from '../import/redact'
import { buildSharedMoments, MAX_SEARCH_TOPICS, SEARCH_TOP_K, type TopicSearch } from './shared'
import { clip, suggestOverlap, userLines, type UserLine } from './topics'

export type PeersDeps = Pick<S1Deps, 'storeRoot' | 'runtime' | 'ossTool' | 'saveDialog' | 'openDialog'> &
  Partial<Pick<S1Deps, 'runtimeRoot' | 'openDirectoryDialog'>> & {
    now?: () => Date
    /** S1-R4-06: timer source for the opt-in periodic scan (tests inject fakes). */
    timers?: Timers
  }

export interface PeersService {
  store: PeerStore
  /** S2-09 local subscription folder. */
  subscription: Subscription
  /** S1-R4-06 opt-in periodic scan (off unless enabled in subscription.json). */
  scheduler: SubscriptionScheduler
  list(): PeerList
  get(fingerprint: string): PeerDetail | null
  importText(text: string): PeerImportResult
  importFile(): Promise<PeerImportResult | null>
  remove(fingerprint: string): boolean
  suggestions(fingerprint: string): Promise<PeerSuggestions>
  /** S1-R3-05: 共同话题 / 共同经历. Manual (called on demand), never on a timer. */
  sharedMoments(fingerprint: string, timezone?: string): Promise<SharedMoments>
  letterDraft(fingerprint: string, timezone: string): Promise<LetterDraft>
  exportLetter(fingerprint: string, markdown: string): Promise<{ path: string | null; bytes: number }>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** recent_activity → `{count, entries}`; search → `{query, results}`. Bare arrays tolerated. */
export function parseHits(text: string, key: 'entries' | 'results'): MemorySearchHit[] {
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(list)) throw new Error(tr(`Runtime returned ${key} that is not a list`, `Runtime 返回的 ${key} 不是列表`))
  return list.filter(
    (e): e is MemorySearchHit => !!e && typeof e === 'object' && typeof (e as MemorySearchHit).id === 'string' && typeof (e as MemorySearchHit).content === 'string'
  )
}

export function createPeersService(deps: PeersDeps): PeersService {
  const now = deps.now ?? (() => new Date())
  const store = createPeerStore({ storeRoot: deps.storeRoot, now })
  // `.navaliaskill` from the subscription folder goes through the same verify + `shared` provenance
  // path as Playbook's manual import. No ossTool: dedupe uses Runtime skill files + Lens Store only.
  let skills: SkillShare | null = null
  const runtimeRoot = deps.runtimeRoot
  const subscription = createSubscription({
    storeRoot: deps.storeRoot,
    peers: store,
    skills: () => {
      if (!runtimeRoot) return null
      skills ??= createSkillShare({ service: createWorkflowService({ storeRoot: deps.storeRoot, runtimeRoot, now }), keys: () => null, now })
      return skills
    },
    pickDir: deps.openDirectoryDialog,
    now
  })
  const scheduler = createSubscriptionScheduler({ subscription, timers: deps.timers, now })

  function mustGet(fingerprint: string): PeerDetail {
    const peer = store.get(fingerprint)
    if (!peer) throw new Error(tr('Peer not found (may have been removed)', '找不到这位朋友（可能已被移除）'))
    return peer
  }

  async function suggestionsFor(peer: PeerDetail): Promise<PeerSuggestions> {
    let graph: ModelGraphResponse
    try {
      graph = await deps.runtime().modelGraph()
    } catch (error) {
      return { suggestions: [], modelError: errorText(error) }
    }
    return { suggestions: suggestOverlap(peer.topics, userLines(graph)), modelError: null }
  }

  /**
   * Literal overlap with the user's model + the Runtime's local `search` per card topic (stdio MCP via
   * deps.ossTool; bounded to MAX_SEARCH_TOPICS calls; stops at the first failure so an unreachable
   * Runtime costs one timeout, not six). Read-only; nothing is written anywhere.
   */
  /** S1-R3-SEC M3: the same lower bound as the letter's `related` search (7-day window − 1 day). */
  function windowSince(timezone: string): string {
    return addDays(letterWindow(now(), timezone).start, -1)
  }

  async function momentsFor(peer: PeerDetail, since: string): Promise<SharedMoments> {
    let lines: UserLine[] = []
    let modelError: string | null = null
    try {
      lines = userLines(await deps.runtime().modelGraph())
    } catch (error) {
      modelError = redactForDisplay(errorText(error))
    }
    const searches: TopicSearch[] = []
    for (const [topicIndex, topic] of peer.topics.slice(0, MAX_SEARCH_TOPICS).entries()) {
      const query = clip(topic.text, 300)
      if (!query) continue
      try {
        searches.push({ topicIndex, hits: parseHits(await deps.ossTool('search', { query, since, top_k: SEARCH_TOP_K }), 'results'), error: null })
      } catch (error) {
        searches.push({ topicIndex, hits: null, error: redactForDisplay(errorText(error)) })
        break
      }
    }
    return buildSharedMoments({ fingerprint: peer.fingerprint, topics: peer.topics, lines, searches, modelError })
  }

  return {
    store,
    subscription,
    scheduler,
    list: () => store.list(),
    get: (fp) => store.get(fp),
    importText: (text) => store.importText(text),

    async importFile() {
      const file = await deps.openDialog({ title: tr("Import a peer's card", '导入朋友的卡片'), filters: [{ name: 'Navalia Card', extensions: ['navaliacard', 'persomecard', 'json'] }] })
      if (!file) return null
      const stat = await fs.stat(file)
      if (stat.size > MAX_CARD_BYTES) return { ok: false, reason: 'too_large', detail: tr('File is too large to be a card', '文件太大，不像是一张卡片') }
      return store.importText(await fs.readFile(file, 'utf8'))
    },

    remove: (fp) => store.remove(fp),

    suggestions: async (fp) => suggestionsFor(mustGet(fp)),

    sharedMoments: async (fp, timezone = 'UTC') => momentsFor(mustGet(fp), windowSince(timezone)),

    async letterDraft(fp, timezone) {
      const peer = mustGet(fp)
      const at = now()
      const range = letterWindow(at, timezone)
      // Generous lower bound; the template filters by local date in `timezone`.
      const since = addDays(range.start, -1)

      let recent: MemorySearchHit[] | null = null
      let recentError: string | null = null
      try {
        recent = parseHits(await deps.ossTool('recent_activity', { since, limit: 200 }), 'entries')
      } catch (error) {
        recentError = errorText(error)
      }

      // S1-FULL C11 / C18: shared moments with THIS friend that both signed (re-verified offline from
      // <LensStore>/moments), visibility `letters`, in the window. No keyword overlap, no search.
      let experiences: Array<{ momentId: string; title: string; start: string; end: string; friend: string }> = []
      let experiencesError: string | null = null
      try {
        const local = createMomentsStore({ storeRoot: deps.storeRoot, now }).list()
        experiences = letterMoments(local.moments, range, peer.fingerprint).map((m) => ({
          momentId: m.momentId,
          title: m.title,
          start: m.start,
          end: m.end,
          friend: peerName({ displayName: m.friendName, fingerprint: m.friendFingerprint })
        }))
      } catch (error) {
        experiencesError = redactForDisplay(errorText(error))
      }
      return buildLetter({
        now: at,
        timezone,
        peer: { fingerprint: peer.fingerprint, displayName: peer.displayName, cardId: peer.cardId, cardIssuedAt: peer.cardIssuedAt },
        recent,
        recentError,
        experiences,
        experiencesError,
        audience: 'friend'
      })
    },

    async exportLetter(fp, markdown) {
      const peer = mustGet(fp)
      const target = await deps.saveDialog({
        title: tr('Export weekly letter draft', '导出每周信草稿'),
        defaultPath: `persome-letter-${now().toISOString().slice(0, 10)}-${peer.fingerprint.slice(0, 8)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (!target) return { path: null, bytes: 0 }
      const body = markdown.endsWith('\n') ? markdown : `${markdown}\n`
      await fs.writeFile(target, body, { encoding: 'utf8', mode: 0o600 })
      return { path: target, bytes: Buffer.byteLength(body, 'utf8') }
    }
  }
}
