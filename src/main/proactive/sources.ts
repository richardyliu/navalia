// S1-R4-05 production data sources for the proactive engine. Everything goes through objects main
// already has: the loopback RuntimeClient (REST 127.0.0.1), the in-process capture service and the
// Runtime MCP tool call. This file opens no socket and makes no request of its own.
//
// Only counts, keys and categorical states leave these functions. Alias keys and todo keys are
// hashed by the engine before they reach the log; none of them reach a notification body.
import type { BehaviorPatterns, RecentActivityResponse } from '../../shared/types'
import type { CaptureStatusView } from '../capture/api'
import { buildBrief, localDateIn, previousDate } from '../library/brief'
import { RuntimeError, type RuntimeClient } from '../runtime/client'
import type { BriefSample, CaptureSample, ProactiveSources, RuntimeSample } from './engine'

export interface ProductionSourceDeps {
  runtime(): RuntimeClient
  captureStatus(): CaptureStatusView | null
  ossTool(name: string, args: Record<string, unknown>): Promise<string>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 64 ? v : null)

/**
 * T5 revision marker from a /health or /status payload: `schema:<schema_revision>|build:<build_version>`
 * when either field is present (a missing half is `-`), else null. Bounded; never the raw payload.
 */
export function runtimeRevisionMarker(payload: Record<string, unknown>): string | null {
  const field = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  const schema = field(payload.schema_revision, 64)
  const build = field(payload.build_version, 128)
  if (!schema && !build) return null
  return `schema:${schema ?? '-'}|build:${build ?? '-'}`
}

export function createProductionSources(deps: ProductionSourceDeps): ProactiveSources {
  return {
    async ownerAliasesPending() {
      const list = await deps.runtime().ownerAliases('pending')
      return list.aliases.filter((a) => a.status === 'pending').map((a) => a.alias_key)
    },

    async capture(): Promise<CaptureSample | null> {
      const cap = deps.captureStatus()
      let health: CaptureSample['health'] = null
      try {
        const h = await deps.runtime().health()
        health = {
          ocr_enabled: typeof h.ocr_enabled === 'boolean' ? h.ocr_enabled : null,
          ocr: str(h.ocr),
          ocr_worker: str(h.ocr_worker),
          capture_pipeline: str(h.capture_pipeline)
        }
      } catch {
        health = null // Runtime down is T5's business, not a capture issue.
      }
      if (!cap && !health) return null
      return {
        captureActive: Boolean(cap?.started),
        accessibility: cap ? cap.permissions.accessibility : null,
        screenRecording: cap ? cap.permissions.screenRecording : null,
        ingestRejectedTotal: cap && Number.isInteger(cap.ingest.rejected) ? cap.ingest.rejected : null,
        health
      }
    },

    async runtime(): Promise<RuntimeSample | null> {
      const client = deps.runtime()
      let health: Record<string, unknown>
      try {
        health = (await client.health()) as Record<string, unknown>
      } catch (error) {
        if (error instanceof RuntimeError && (error.code === 'unreachable' || error.code === 'timeout')) return { reachable: false, revision: null }
        return null // unknown failure: stay silent rather than guess "down"
      }
      // Marker for "the Runtime changed under running agent sessions". Runtime R10 (build 7066066+)
      // reports schema_revision + build_version on /health and /status; build_version carries the
      // git sha, so a code-only redeploy changes the marker too. Older Runtimes: /status version.
      let revision = runtimeRevisionMarker(health)
      if (!revision) {
        try {
          const s = (await client.status()) as unknown as Record<string, unknown>
          revision =
            runtimeRevisionMarker(s) ?? (typeof s.version === 'string' && s.version ? `version:${s.version.slice(0, 64)}` : null)
        } catch {
          revision = null
        }
      }
      return { reachable: true, revision }
    },

    async brief(now: number, timezone: string): Promise<BriefSample | null> {
      const recent = JSON.parse(await deps.ossTool('recent_activity', { limit: 100 })) as RecentActivityResponse
      let patterns: BehaviorPatterns | null = null
      try {
        patterns = JSON.parse(await deps.ossTool('behavior_patterns', {})) as BehaviorPatterns
      } catch {
        patterns = null
      }
      const b = buildBrief({ now, timezone, recent, patterns, het: null })
      const yesterday = previousDate(localDateIn(now, timezone))
      return {
        nextSteps: b.nextSteps.map((n) => n.key),
        yesterdayTodos: b.nextSteps
          .filter((n) => n.kind === 'todo' && n.day === 'yesterday' && n.source.kind === 'record' && n.source.date === yesterday)
          .map((n) => n.key)
      }
    }
  }
}
