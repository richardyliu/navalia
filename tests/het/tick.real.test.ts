import { statSync } from 'node:fs'
import { expect, test } from 'vitest'
import { readClaudeProjects } from './readers'
import { disabledTransport } from '../../src/main/het/assessor'
import { hetSummary, openHetDb } from '../../src/main/het/ledger'
import { DEFAULT_HET_SETTINGS } from '../../src/main/het/settings'
import { tick } from '../../src/main/het/tick'

/**
 * Real dry run (read-only on ~/.claude/projects) into a temp het.db given by HET_DB
 * (must be a fresh path under the scratchpad). Disabled transport → zero LLM calls.
 * Prints aggregate counts only.
 */
test.runIf(process.env.HET_REAL_TICK === '1' && !!process.env.HET_DB)('real dry tick → all settled tasks needs_assessment, 0 minutes', async () => {
  const file = process.env.HET_DB!
  expect(file.includes('/scratchpad/')).toBe(true)
  const now = Date.now()
  const db = openHetDb(file, now)
  const cc = readClaudeProjects()
  const deps = { db, transport: disabledTransport, settings: DEFAULT_HET_SETTINGS, input: { events: cc.events, sessionTitles: cc.sessionTitles } }
  const r1 = await tick(deps, now)
  const r2 = await tick(deps, now) // idempotency on real data
  const q = (sql: string) => db.prepare(sql).all()
  const sum = hetSummary(db, { now, days: 3650 })
  const out = {
    tick1: r1,
    tick2: { upserts: r2.upserts, assess: r2.assess },
    status: q('SELECT status, COUNT(*) AS n FROM het_tasks GROUP BY status ORDER BY status'),
    minutesNonNull: q('SELECT COUNT(*) AS n FROM het_tasks WHERE minutes_tenths IS NOT NULL'),
    totalMinutesTenths: sum.total_minutes_tenths,
    pending: sum.pending,
    state: sum.state,
    evidenceRows: q('SELECT COUNT(*) AS n, MAX(length(summary)) AS maxSummaryLen FROM het_evidence'),
    maxTitleLen: q('SELECT MAX(length(title)) AS m FROM het_tasks'),
    agentCalls: q('SELECT transport, outcome, COUNT(*) AS n FROM agent_calls GROUP BY 1, 2'),
    auditEvents: q('SELECT kind, COUNT(*) AS n FROM het_events GROUP BY kind ORDER BY kind'),
  }
  expect(sum.total_minutes_tenths).toBe(0)
  db.close() // checkpoints WAL into the main file
  console.log('HET_REAL_TICK ' + JSON.stringify({ ...out, dbBytesAfterClose: statSync(file).size }))
}, 120_000)
