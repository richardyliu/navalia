import { closeSync, fstatSync, openSync, readFileSync, constants } from 'node:fs'
import { z } from 'zod'
import type { AssessorTransport, TransportOutcome } from './assessor'

/**
 * E2E-only fixture assessor (never an LLM). Enabled only when the service gets
 * `allowFakeAssessor: true` (main passes `!app.isPackaged`) AND `LENS_HET_FAKE_ASSESSOR`
 * points at a JSON file:
 *
 *   {
 *     "byTaskId": { "het_<20 hex>": <verdict object> | "quota" | "offline" | "error" | "budget_unavailable" },
 *     "default":  <verdict object> | <outcome string>          // optional; otherwise budget_unavailable
 *   }
 *
 * Verdict objects are passed to the assessor as JSON TEXT, so they go through the normal
 * `parseVerdict` (zod strict + evidence-ref resolution) path: a fixture containing
 * `minutes` or extra keys is rejected as `invalid` exactly like a model reply would be.
 * There is no "by kind" key: kind is the assessor's output, unknown before assessment.
 */

export const FAKE_ASSESSOR_ENV = 'LENS_HET_FAKE_ASSESSOR'

const Outcome = z.enum(['quota', 'offline', 'error', 'budget_unavailable'])
const Entry = z.union([Outcome, z.record(z.string(), z.unknown())])
const FixtureSchema = z.strictObject({
  byTaskId: z.record(z.string().regex(/^het_[0-9a-f]{20}$/), Entry).optional(),
  default: Entry.optional()
})
export type AssessorFixture = z.infer<typeof FixtureSchema>

export function readAssessorFixture(file: string): AssessorFixture {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > 1024 * 1024) throw new Error('fake assessor fixture must be a regular file ≤ 1 MB')
    return FixtureSchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
  } finally {
    closeSync(fd)
  }
}

export function fixtureTransport(fixture: AssessorFixture): AssessorTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    name: 'fixture',
    calls,
    async complete(req) {
      calls.push(req.taskId)
      const entry = fixture.byTaskId?.[req.taskId] ?? fixture.default
      if (entry === undefined) return { outcome: 'budget_unavailable' }
      if (typeof entry === 'string') return { outcome: entry as TransportOutcome }
      return { outcome: 'ok', text: JSON.stringify(entry) }
    }
  }
}
