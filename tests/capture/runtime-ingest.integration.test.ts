import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CaptureCoordinator, TRIGGERS } from '../../src/main/capture/coordinator'
import { buildFrame } from '../../src/main/capture/frame'
import { IngestClient, type IngestOutcome } from '../../src/main/capture/ingest-client'
import { loadNative } from '../../src/main/capture/native'
import { resolvePort } from '../../src/main/runtime/paths'
import { readLocalToken } from '../../src/main/runtime/token'

/**
 * Real-Runtime ingest check. Opt-in: point LENS_INGEST_E2E_ROOT at a temp
 * PERSOME_ROOT whose runtime runs with `[capture] source = "ingest"`.
 * Never point it at ~/.persome.
 */
const root = process.env.LENS_INGEST_E2E_ROOT
const enabled = !!root && root.startsWith('/tmp/persome-test/')

describe.skipIf(!enabled)('coordinator -> addon -> ingest -> temp Runtime', () => {
  it('delivers frames end to end and the Runtime files them', async () => {
    const native = loadNative(path.resolve(__dirname, '../..')).native!
    const port = resolvePort(root!)
    const token = readLocalToken(root!)
    const client = new IngestClient({ baseUrl: `http://127.0.0.1:${port}`, getToken: () => token })
    const outcomes: IngestOutcome[] = []
    const buffer = path.join(root!, 'capture-buffer')
    const before = new Set(fs.readdirSync(buffer))

    const coordinator = new CaptureCoordinator({
      capture: async (trigger) => {
        const built = await buildFrame(native, trigger, { includeScreenshot: true })
        if (!built.frame) return false
        const r = await client.push(built.frame)
        outcomes.push(r)
        return r.outcome === 'written' || r.outcome === 'deduped'
      }
    })
    coordinator.start(undefined, { eventType: TRIGGERS.startup, bundleId: 'e2e.startup' })
    await new Promise((r) => setTimeout(r, 1200))
    coordinator.onEvent({ eventType: TRIGGERS.focusedWindowChanged, bundleId: 'e2e.other', appName: 'Other' })
    await new Promise((r) => setTimeout(r, 1200))
    coordinator.stop()

    // Identical on-screen content is content-deduped by the Runtime (HTTP 200,
    // `deduped`), across runs too, so only the tri-state contract is asserted.
    expect(outcomes).toHaveLength(2)
    for (const o of outcomes) expect(['written', 'deduped']).toContain(o.outcome)
    const written = outcomes.filter((o) => o.outcome === 'written').length
    const added = fs.readdirSync(buffer).filter((f) => !before.has(f) && f.endsWith('.json'))
    expect(added.length).toBe(written)
    const files = fs.readdirSync(buffer).filter((f) => f.endsWith('.json')).sort()
    expect(files.length).toBeGreaterThan(0)
    const stored = JSON.parse(fs.readFileSync(path.join(buffer, files[files.length - 1]), 'utf8'))
    expect(stored.capture_source).toBe('ingest')
    expect(typeof stored.window_meta.bundle_id).toBe('string')
    // eslint-disable-next-line no-console
    console.log('E2E', JSON.stringify({ outcomes, added, keys: Object.keys(stored).sort(), ax_unavailable: stored.ax_unavailable ?? false, window_meta: stored.window_meta }))
  }, 30_000)
})
