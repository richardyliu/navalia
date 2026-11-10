import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig, type CloudConfig } from './config.ts'
import { openDb, type Db } from './db.ts'
import { HttpError, bearerToken, readJson, sendError, sendJson, sendNoContent } from './http.ts'
import { logRequest, safeMethod, stdoutSink, type LogSink } from './log.ts'
import { FixedWindowLimiter } from './ratelimit.ts'
import { authenticate, decodePublicKey, deleteAccount, fingerprintOf, issueChallenge, purgeExpired, revokeSession, verifyChallenge, type AuthDeps } from './auth.ts'
import { VERSION } from './version.ts'
import { createAdapter, type LlmAdapter } from './llm.ts'
import { handleChat, handleUsage, type ChatDeps } from './chat.ts'
import { deleteCards, fetchCard, publishCard, type CardDeps } from './cards.ts'
import {
  confirmPage,
  confirmSubscription,
  deleteSubscriber,
  handleSubscribe,
  listDeliveries,
  listLetters,
  listSubscribers,
  lettersBy,
  publishLetter,
  purgeMailData,
  resubscribe,
  subscribePage,
  unsubscribe,
  unsubscribePage,
  type LetterDeps
} from './letters.ts'
import { createMailer, type Mailer } from './mail.ts'
import { Outbox } from './outbox.ts'
import { resolvePepper } from './secrets.ts'
import { createSttAdapter, type SttAdapter } from './stt.ts'
import {
  SttWorker,
  audioNamesForAccount,
  createMeeting,
  deleteMeeting,
  finishMeeting,
  getMeeting,
  getTranscript,
  listMeetings,
  purgeMeetings,
  putChunk,
  removeAudio,
  sweepAudio,
  type MeetingDeps
} from './meetings.ts'
import { acceptMoment, declineMoment, deleteMoment, listMoments, proposeMoment, purgeMomentUsage, type MomentDeps } from './moments.ts'

export interface ServerDeps {
  /** Clock in ms since epoch; tests inject a controllable one. */
  now?: () => number
  /** Request-log sink; tests capture lines. */
  log?: LogSink
  /** Pre-opened DB (otherwise opened from config.dbPath). */
  db?: Db
  /** LLM adapter override (otherwise built from config.llm). */
  llm?: LlmAdapter | null
  /** Mail transport override (otherwise built from config.mail; null = mail disabled). */
  mailer?: Mailer | null
  /** false = do not start the outbox poller (tests call app.outbox.drain()). Default true. */
  startOutbox?: boolean
  /** Speech-to-text adapter override (otherwise built from config.stt; null = meetings disabled). */
  stt?: SttAdapter | null
  /** false = do not start the transcription poller (tests call app.stt.drain()). Default true. */
  startStt?: boolean
}

export interface CloudServer {
  server: Server
  db: Db
  config: CloudConfig
  outbox: Outbox
  stt: SttWorker
  /** Runs the retention GC now (also runs every 10 minutes). */
  purge(): void
  /** Resolves once listening; returns the bound port. */
  listen(port?: number, host?: string): Promise<number>
  close(): Promise<void>
}

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  /** Raw (undecoded) path segments matched by `:name` in the route template. */
  params: Record<string, string>
  ip: string
  /** Rate-limit by account; throws 429. */
  limitAccount(accountId: string): void
}

interface Route {
  method: string
  /** Template; `:name` matches one non-empty segment. Literal routes must precede overlapping param routes. */
  path: string
  handler: (ctx: Ctx) => Promise<void>
}

function matchPath(template: string, path: string): Record<string, string> | null {
  const t = template.split('/')
  const p = path.split('/')
  if (t.length !== p.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) {
      if (p[i] === '') return null
      params[t[i].slice(1)] = p[i]
    } else if (t[i] !== p[i]) return null
  }
  return params
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for']
    const v = Array.isArray(xff) ? xff[xff.length - 1] : xff
    if (v) {
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.length > 0) return parts[parts.length - 1]
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function createServer(config: CloudConfig, deps: ServerDeps = {}): CloudServer {
  const now = deps.now ?? Date.now
  const log = deps.log ?? stdoutSink
  const db = deps.db ?? openDb(config.dbPath)
  const auth: AuthDeps = {
    db,
    now,
    audience: config.publicOrigin,
    challengeTtlS: config.challengeTtlS,
    tokenTtlS: config.tokenTtlS
  }
  const chatDeps: ChatDeps = {
    db,
    now,
    adapter: deps.llm !== undefined ? deps.llm : createAdapter(config.llm),
    dailyTokens: config.chatDailyTokens,
    model: config.llm.model
  }
  const ipLimiter = new FixedWindowLimiter(config.rateWindowS, config.rateIpMax)
  const accountLimiter = new FixedWindowLimiter(config.rateWindowS, config.rateAccountMax)
  const cardFetchLimiter = new FixedWindowLimiter(config.rateWindowS, config.cardFetchMax)
  const subscribeIpLimiter = new FixedWindowLimiter(3600, config.subscribeIpPerHour)
  const subscribePublisherLimiter = new FixedWindowLimiter(3600, config.subscribePublisherPerHour)
  const cardDeps: CardDeps = { db, now }
  const momentDeps: MomentDeps = { db, now }
  const pepper = resolvePepper(db, config.emailPepper, now())
  const mailer = deps.mailer !== undefined ? deps.mailer : createMailer(config.mail)
  const outbox = new Outbox({ db, now, mailer, origin: config.publicOrigin, pepper })
  const letterDeps: LetterDeps = {
    db,
    now,
    origin: config.publicOrigin,
    pepper,
    mailEnabled: mailer !== null,
    poke: () => outbox.poke()
  }

  const sttAdapter = deps.stt !== undefined ? deps.stt : createSttAdapter(config.stt)
  const sttWorker = new SttWorker({ db, now, stt: sttAdapter, audioDir: config.audioDir, concurrency: config.stt.concurrency })
  const meetingDeps: MeetingDeps = {
    db,
    now,
    stt: sttAdapter,
    dailySeconds: config.sttDailySeconds,
    audioDir: config.audioDir,
    poke: () => sttWorker.poke()
  }
  const chunkLimiter = new FixedWindowLimiter(config.rateWindowS, config.meetingChunkRateMax)

  const tooMany = (retryAfterS: number): HttpError =>
    new HttpError(429, 'rate_limited', 'Too many requests', { 'retry-after': String(retryAfterS) })

  const limitAccount = (accountId: string): void => {
    const d = accountLimiter.hit(accountId, now())
    if (!d.ok) throw tooMany(d.retryAfterS)
  }

  const hit = (l: FixedWindowLimiter, key: string): void => {
    const d = l.hit(key, now())
    if (!d.ok) throw tooMany(d.retryAfterS)
  }

  const authed = async (ctx: Ctx) => {
    const s = authenticate(auth, bearerToken(ctx.req))
    ctx.limitAccount(s.accountId)
    return s
  }

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/health',
      handler: async ({ res }) => sendJson(res, 200, { ok: true, version: VERSION })
    },
    {
      method: 'POST',
      path: '/v1/auth/challenge',
      handler: async (ctx) => {
        const body = (await readJson(ctx.req, config.bodyLimitBytes, true))!
        const raw = decodePublicKey(body.public_key)
        if (raw) ctx.limitAccount(fingerprintOf(raw))
        sendJson(ctx.res, 200, issueChallenge(auth, body))
      }
    },
    {
      method: 'POST',
      path: '/v1/auth/verify',
      handler: async (ctx) => {
        const body = (await readJson(ctx.req, config.bodyLimitBytes, true))!
        const raw = decodePublicKey(body.public_key)
        if (raw) ctx.limitAccount(fingerprintOf(raw))
        sendJson(ctx.res, 200, verifyChallenge(auth, body).response)
      }
    },
    {
      method: 'GET',
      path: '/v1/auth/session',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, { account_id: s.accountId, fingerprint: s.accountId, expires_at: new Date(s.expiresAt).toISOString() })
      }
    },
    {
      method: 'POST',
      path: '/v1/auth/logout',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        revokeSession(auth, s)
        sendNoContent(ctx.res)
      }
    },
    {
      method: 'DELETE',
      path: '/v1/account',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        // Collect audio files first: the CASCADE removes the rows that name them.
        const audio = audioNamesForAccount(db, s.accountId)
        deleteAccount(auth, s)
        for (const n of audio) removeAudio(config.audioDir, n)
        sendNoContent(ctx.res)
      }
    },
    {
      method: 'POST',
      path: '/v1/chat/completions',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await handleChat(ctx.req, ctx.res, chatDeps, s.accountId)
      }
    },
    {
      method: 'GET',
      path: '/v1/usage',
      handler: async (ctx) => {
        const s = await authed(ctx)
        handleUsage(ctx.res, chatDeps, s.accountId)
      }
    },
    // ── C8 cards ──
    {
      method: 'PUT',
      path: '/v1/cards',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, await publishCard(cardDeps, ctx.req, s.accountId))
      }
    },
    {
      method: 'DELETE',
      path: '/v1/cards',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        deleteCards(cardDeps, s.accountId)
        sendNoContent(ctx.res)
      }
    },
    {
      method: 'GET',
      path: '/v1/cards/:fingerprint',
      handler: async (ctx) => {
        const s = await authed(ctx)
        hit(cardFetchLimiter, s.accountId)
        sendJson(ctx.res, 200, fetchCard(cardDeps, ctx.params.fingerprint))
      }
    },
    // ── C9 letters ──
    {
      method: 'POST',
      path: '/v1/letters',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 202, await publishLetter(letterDeps, ctx.req, s.accountId))
      }
    },
    {
      method: 'GET',
      path: '/v1/letters',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, listLetters(letterDeps, s.accountId))
      }
    },
    {
      method: 'GET',
      path: '/v1/letters/by/:fingerprint',
      handler: async (ctx) => {
        const s = await authed(ctx)
        hit(cardFetchLimiter, s.accountId)
        sendJson(ctx.res, 200, lettersBy(letterDeps, ctx.params.fingerprint))
      }
    },
    {
      method: 'GET',
      path: '/v1/letters/:letter_id/deliveries',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, listDeliveries(letterDeps, s.accountId, ctx.params.letter_id))
      }
    },
    {
      method: 'GET',
      path: '/v1/subscribers',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, listSubscribers(letterDeps, s.accountId))
      }
    },
    {
      method: 'DELETE',
      path: '/v1/subscribers/:id',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        deleteSubscriber(letterDeps, s.accountId, ctx.params.id)
        sendNoContent(ctx.res)
      }
    },
    // ── C13 meetings ──
    {
      method: 'POST',
      path: '/v1/meetings',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 201, await createMeeting(meetingDeps, ctx.req, config.bodyLimitBytes, s.accountId))
      }
    },
    {
      method: 'GET',
      path: '/v1/meetings',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, listMeetings(meetingDeps, s.accountId))
      }
    },
    {
      method: 'PUT',
      path: '/v1/meetings/:id/chunks/:seq',
      handler: async (ctx) => {
        const s = await authed(ctx)
        hit(chunkLimiter, s.accountId)
        const r = await putChunk(meetingDeps, ctx.req, s.accountId, ctx.params.id, ctx.params.seq)
        sendJson(ctx.res, r.status, r.body)
      }
    },
    {
      method: 'POST',
      path: '/v1/meetings/:id/finish',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 202, await finishMeeting(meetingDeps, ctx.req, config.bodyLimitBytes, s.accountId, ctx.params.id))
      }
    },
    {
      method: 'GET',
      path: '/v1/meetings/:id/transcript',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, getTranscript(meetingDeps, s.accountId, ctx.params.id))
      }
    },
    {
      method: 'GET',
      path: '/v1/meetings/:id',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, getMeeting(meetingDeps, s.accountId, ctx.params.id))
      }
    },
    {
      method: 'DELETE',
      path: '/v1/meetings/:id',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        deleteMeeting(meetingDeps, s.accountId, ctx.params.id)
        sendNoContent(ctx.res)
      }
    },
    // ── C18 shared moments ──
    {
      method: 'POST',
      path: '/v1/moments',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 201, await proposeMoment(momentDeps, ctx.req, s.accountId))
      }
    },
    {
      method: 'GET',
      path: '/v1/moments',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, listMoments(momentDeps, s.accountId))
      }
    },
    {
      method: 'POST',
      path: '/v1/moments/:id/accept',
      handler: async (ctx) => {
        const s = await authed(ctx)
        sendJson(ctx.res, 200, await acceptMoment(momentDeps, ctx.req, s.accountId, ctx.params.id))
      }
    },
    {
      method: 'POST',
      path: '/v1/moments/:id/decline',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        sendJson(ctx.res, 200, declineMoment(momentDeps, s.accountId, ctx.params.id))
      }
    },
    {
      method: 'DELETE',
      path: '/v1/moments/:id',
      handler: async (ctx) => {
        const s = await authed(ctx)
        await readJson(ctx.req, config.bodyLimitBytes, false)
        deleteMoment(momentDeps, s.accountId, ctx.params.id)
        sendNoContent(ctx.res)
      }
    },
    // ── C9 public (no auth) ──
    {
      method: 'POST',
      path: '/v1/subscribe',
      handler: async (ctx) => {
        hit(subscribeIpLimiter, ctx.ip)
        await handleSubscribe(letterDeps, ctx.req, ctx.res, (fp) => hit(subscribePublisherLimiter, fp))
      }
    },
    {
      method: 'GET',
      path: '/v1/subscribe/confirm',
      handler: async (ctx) => confirmPage(ctx.res, ctx.req)
    },
    {
      method: 'POST',
      path: '/v1/subscribe/confirm',
      handler: async (ctx) => confirmSubscription(letterDeps, ctx.req, ctx.res)
    },
    {
      method: 'GET',
      path: '/v1/unsubscribe',
      handler: async (ctx) => unsubscribePage(letterDeps, ctx.req, ctx.res)
    },
    {
      method: 'POST',
      path: '/v1/unsubscribe',
      handler: async (ctx) => unsubscribe(letterDeps, ctx.req, ctx.res)
    },
    {
      method: 'POST',
      path: '/v1/resubscribe',
      handler: async (ctx) => {
        hit(subscribeIpLimiter, ctx.ip)
        await resubscribe(letterDeps, ctx.req, ctx.res)
      }
    },
    {
      method: 'GET',
      path: '/s/:fingerprint',
      handler: async (ctx) => subscribePage(letterDeps, ctx.res, ctx.params.fingerprint)
    }
  ]

  const server = createHttpServer(async (req, res) => {
    const started = performance.now()
    const reqId = randomUUID()
    res.setHeader('x-request-id', reqId)
    let route = 'unmatched'
    try {
      const ip = clientIp(req, config.trustProxy)
      const d = ipLimiter.hit(ip, now())
      if (!d.ok) throw tooMany(d.retryAfterS)
      // Path only; the query string is ignored and never logged.
      const rawUrl = req.url ?? '/'
      const qi = rawUrl.indexOf('?')
      const path = qi === -1 ? rawUrl : rawUrl.slice(0, qi)
      let match: Route | undefined
      let params: Record<string, string> = {}
      for (const r of routes) {
        if (r.method !== req.method) continue
        const p = matchPath(r.path, path)
        if (p) {
          match = r
          params = p
          break
        }
      }
      if (!match) throw new HttpError(404, 'not_found', 'Not found')
      route = match.path
      await match.handler({ req, res, params, ip, limitAccount })
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal_error', 'Internal error')
      if (!res.headersSent) {
        if (e.status === 413 || e.status === 415 || !req.complete) res.setHeader('connection', 'close')
        sendError(res, e)
      } else {
        res.destroy()
      }
      // Drain (discard) any unread body so the client sees the response, not a reset.
      if (!req.complete) req.resume()
    } finally {
      logRequest(log, { req_id: reqId, method: safeMethod(req.method), route, status: res.statusCode, ms: performance.now() - started })
    }
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000

  const purge = (): void => {
    purgeExpired(auth)
    purgeMailData(db, now())
    purgeMeetings(db, config.audioDir, now())
    sweepAudio(db, config.audioDir, now())
    purgeMomentUsage(db, now())
  }
  const gc = setInterval(() => {
    try {
      purge()
    } catch {
      /* best effort; next tick retries */
    }
  }, 10 * 60 * 1000)
  gc.unref()
  if (deps.startOutbox !== false) outbox.start()
  if (deps.startStt !== false) sttWorker.start()

  return {
    server,
    db,
    config,
    outbox,
    stt: sttWorker,
    purge,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        })
      })
    },
    async close() {
      clearInterval(gc)
      await outbox.stop()
      await sttWorker.stop()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      if (deps.mailer === undefined) mailer?.close()
      if (!deps.db) db.close()
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const config = loadConfig()
  const app = createServer(config)
  const port = await app.listen()
  process.stdout.write(JSON.stringify({ event: 'listening', host: config.host, port, audience: config.publicOrigin, llm_mode: config.llm.mode ?? 'off', mail_mode: config.mail.mode ?? 'off', stt_mode: config.stt.mode ?? 'off', email_pepper: config.emailPepper ? 'env' : 'db', version: VERSION }) + '\n')
  const shutdown = (): void => {
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
