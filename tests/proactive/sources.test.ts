// S1-R4-05 production source adapters over a fake RuntimeClient / capture status / MCP tool call.
import { describe, expect, it } from 'vitest'
import type { CaptureStatusView } from '../../src/main/capture/api'
import { RuntimeError, type RuntimeClient } from '../../src/main/runtime/client'
import { createProductionSources, runtimeRevisionMarker } from '../../src/main/proactive/sources'

function client(over: Partial<Record<'health' | 'status' | 'ownerAliases', () => Promise<unknown>>>): RuntimeClient {
  return {
    health: over.health ?? (async () => ({ status: 'ok' })),
    status: over.status ?? (async () => ({ version: '0.4.0' })),
    ownerAliases: over.ownerAliases ?? (async () => ({ status: 'pending', aliases: [] }))
  } as unknown as RuntimeClient
}

const cap = (o: Partial<CaptureStatusView> = {}): CaptureStatusView =>
  ({ started: true, permissions: { accessibility: true, screenRecording: false }, ingest: { rejected: 4 }, ...o }) as unknown as CaptureStatusView

const row = (alias: string, status = 'pending') => ({ alias, alias_key: alias.toLowerCase(), status, confidence: 0.5, evidence_count: 1, first_seen_at: null, last_seen_at: null, activated_at: null, decision_source: null, evidence: [] })

describe('production sources', () => {
  it('T3 returns pending alias keys only', async () => {
    const s = createProductionSources({ runtime: () => client({ ownerAliases: async () => ({ status: 'pending', aliases: [row('Alice'), row('Bob', 'active')] }) }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await s.ownerAliasesPending()).toEqual(['alice'])
  })

  it('T4 maps capture status + /health fields; non-string health values become null', async () => {
    const s = createProductionSources({
      runtime: () => client({ health: async () => ({ ocr_enabled: true, ocr: 'degraded', ocr_worker: 42, capture_pipeline: 'ok' }) }),
      captureStatus: () => cap(),
      ossTool: async () => '{}'
    })
    expect(await s.capture()).toEqual({
      captureActive: true,
      accessibility: true,
      screenRecording: false,
      ingestRejectedTotal: 4,
      health: { ocr_enabled: true, ocr: 'degraded', ocr_worker: null, capture_pipeline: 'ok' }
    })
  })

  it('T5: unreachable / timeout → down; other errors → unknown (silent); revision from schema_revision, else version', async () => {
    const down = createProductionSources({ runtime: () => client({ health: async () => { throw new RuntimeError('unreachable', 'x') } }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await down.runtime()).toEqual({ reachable: false, revision: null })
    const weird = createProductionSources({ runtime: () => client({ health: async () => { throw new RuntimeError('schema', 'x') } }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await weird.runtime()).toBeNull()
    const rev = createProductionSources({ runtime: () => client({ health: async () => ({ schema_revision: '2026-11-05.3' }) }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await rev.runtime()).toEqual({ reachable: true, revision: 'schema:2026-11-05.3|build:-' })
    const ver = createProductionSources({ runtime: () => client({}), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await ver.runtime()).toEqual({ reachable: true, revision: 'version:0.4.0' })
  })

  it('T5 keys off schema_revision + build_version (R10), so a code-only redeploy changes the marker', async () => {
    const at = (build: string) =>
      createProductionSources({
        runtime: () => client({ health: async () => ({ status: 'ok', schema_revision: '2026-11-05.3', build_version: build }), status: async () => { throw new Error('must not need /status') } }),
        captureStatus: () => null,
        ossTool: async () => '{}'
      }).runtime()
    const a = await at('0.3.2+g462361d')
    const b = await at('0.3.2+g7066066')
    expect(a).toEqual({ reachable: true, revision: 'schema:2026-11-05.3|build:0.3.2+g462361d' })
    expect(b?.revision).not.toBe(a?.revision)
  })

  it('T5 falls back to /status identity fields, then /status version, when /health has none', async () => {
    const viaStatus = createProductionSources({
      runtime: () => client({ status: async () => ({ version: '0.3.2', schema_revision: '2026-11-05.3', build_version: '0.3.2+gabc1234' }) }),
      captureStatus: () => null,
      ossTool: async () => '{}'
    })
    expect(await viaStatus.runtime()).toEqual({ reachable: true, revision: 'schema:2026-11-05.3|build:0.3.2+gabc1234' })
    const old = createProductionSources({ runtime: () => client({ status: async () => ({ version: '0.3.2' }) }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await old.runtime()).toEqual({ reachable: true, revision: 'version:0.3.2' })
    const broken = createProductionSources({ runtime: () => client({ status: async () => { throw new RuntimeError('timeout', 'x') } }), captureStatus: () => null, ossTool: async () => '{}' })
    expect(await broken.runtime()).toEqual({ reachable: true, revision: null })
  })

  it('runtimeRevisionMarker bounds its input and ignores non-strings', () => {
    expect(runtimeRevisionMarker({})).toBeNull()
    expect(runtimeRevisionMarker({ schema_revision: 42, build_version: '' })).toBeNull()
    expect(runtimeRevisionMarker({ build_version: '0.3.2' })).toBe('schema:-|build:0.3.2')
    expect(runtimeRevisionMarker({ schema_revision: 'x'.repeat(500) })!.length).toBeLessThan(100)
  })

  it('T1 / T2 come from the deterministic brief over recent_activity (no LLM)', async () => {
    const now = Date.parse('2026-11-05T04:00:00Z') // 12:00 Shanghai
    const recent = {
      count: 3,
      entries: [
        { id: 'e1', path: 'event-2026-11-04.md', timestamp: '2026-11-04T10:00:00+08:00', content: '- [ ] 给 Alice 回邮件 https://example.com' },
        { id: 'e2', path: 'event-2026-11-05.md', timestamp: '2026-11-05T09:00:00+08:00', content: 'TODO: 写周报' },
        { id: 'e3', path: 'event-2026-11-01.md', timestamp: '2026-11-01T09:00:00+08:00', content: '- [ ] 很久以前的事' }
      ]
    }
    const tools: string[] = []
    const s = createProductionSources({
      runtime: () => client({}),
      captureStatus: () => null,
      ossTool: async (name) => {
        tools.push(name)
        if (name === 'recent_activity') return JSON.stringify(recent)
        throw new Error('no patterns')
      }
    })
    const b = await s.brief(now, 'Asia/Shanghai')
    expect(tools).toEqual(['recent_activity', 'behavior_patterns'])
    expect(b!.nextSteps).toHaveLength(2)
    expect(b!.yesterdayTodos).toHaveLength(1)
  })
})
