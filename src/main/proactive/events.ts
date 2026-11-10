// S1-FULL C17: typed in-process event bus for event-based proactive triggers (T8 / T9).
//
// Other planes publish facts they already know locally (see the C16-C17 wiring request):
//   - meetings: `meeting.transcript_ready` after the transcript file was written (one item per segment).
//   - peers / subscriptions: `peers.moment_accepted` when the user accepts a shared moment.
// A publish is a plain function call in main. It never opens a socket, never calls an LLM, and the
// payload is validated here; an invalid payload is dropped (returns false) and never throws into the
// publisher. Ids and item ids are hashed before they reach state / logs; `label` (optional, e.g. a
// meeting title) is kept in memory only and shown only if the user enabled `detail`.
import { z } from 'zod'

export const PROACTIVE_EVENT_TYPES = ['meeting.transcript_ready', 'peers.moment_accepted'] as const
export type ProactiveEventType = (typeof PROACTIVE_EVENT_TYPES)[number]

/** Event type → the trigger it feeds. */
export const EVENT_TRIGGER = {
  'meeting.transcript_ready': 'meeting_ready',
  'peers.moment_accepted': 'friend_moment'
} as const satisfies Record<ProactiveEventType, 'meeting_ready' | 'friend_moment'>

/** One concrete item backing the event, with its own evidence pointer (segment time, entry path…). */
export interface ProactiveEventItem {
  id: string
  /** Non-empty evidence pointer. Items without evidence do not count toward the gate. */
  evidence: string
}

export interface ProactiveEvent {
  type: ProactiveEventType
  /** Publisher's stable id (meeting id, moment id). Hashed before storage. */
  id: string
  items: ProactiveEventItem[]
  /** Optional short label; memory only; shown only with `detail` on. */
  label?: string
}

const ItemSchema = z.strictObject({ id: z.string().min(1).max(200), evidence: z.string().max(400) })
export const ProactiveEventSchema = z.strictObject({
  type: z.enum(PROACTIVE_EVENT_TYPES),
  id: z.string().min(1).max(200),
  items: z.array(ItemSchema).max(5000),
  label: z.string().max(400).optional()
})

export type ProactiveEventListener = (event: ProactiveEvent) => void

export interface ProactiveEventBus {
  /** Returns true when the event was valid and handed to the listeners. Never throws. */
  publish(event: ProactiveEvent): boolean
  subscribe(listener: ProactiveEventListener): () => void
}

export function createProactiveEventBus(): ProactiveEventBus {
  const listeners = new Set<ProactiveEventListener>()
  return {
    publish(raw) {
      const parsed = ProactiveEventSchema.safeParse(raw)
      if (!parsed.success) return false
      for (const l of listeners) {
        try {
          l(parsed.data)
        } catch {
          // A listener failure never reaches the publisher.
        }
      }
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

/** Distinct item ids that carry a non-empty evidence pointer: the only items the gate counts. */
export function evidencedItemIds(event: Pick<ProactiveEvent, 'items'>): string[] {
  return [...new Set(event.items.filter((i) => i.evidence.trim().length > 0).map((i) => i.id))]
}
