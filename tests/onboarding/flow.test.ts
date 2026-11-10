import { describe, expect, it } from 'vitest'
import { libraryHeadline } from '../../src/main/library/aggregate'
import {
  INITIAL_FLOW,
  ONBOARDING_STEPS,
  runtimeOfflineHeadline,
  agentRows,
  currentStep,
  doneHeadline,
  finishPayload,
  flowReducer,
  isLastStep,
  permissionRows,
  progressLabel,
  type FlowAction,
  type FlowState
} from '../../src/renderer/src/components/onboarding/flow'

const run = (...actions: FlowAction[]): FlowState => actions.reduce(flowReducer, INITIAL_FLOW)

describe('onboarding flow state machine', () => {
  it('has the five steps in order', () => {
    expect(ONBOARDING_STEPS).toEqual(['welcome', 'permissions', 'connections', 'import', 'done'])
    expect(currentStep(INITIAL_FLOW)).toBe('welcome')
    expect(progressLabel(INITIAL_FLOW)).toBe('1 / 5')
  })

  it('next walks every step and stops at done', () => {
    const seen: string[] = []
    let s = INITIAL_FLOW
    for (let i = 0; i < 8; i++) {
      seen.push(currentStep(s))
      s = flowReducer(s, { type: 'next' })
    }
    expect(seen.slice(0, 5)).toEqual([...ONBOARDING_STEPS])
    expect(currentStep(s)).toBe('done')
    expect(isLastStep(s)).toBe(true)
    expect(s.finished).toBeNull()
  })

  it('back never goes below the first step', () => {
    expect(currentStep(run({ type: 'back' }))).toBe('welcome')
    expect(currentStep(run({ type: 'next' }, { type: 'next' }, { type: 'back' }))).toBe('permissions')
  })

  it('skipStep advances like next', () => {
    expect(currentStep(run({ type: 'skipStep' }, { type: 'skipStep' }))).toBe('connections')
  })

  it('skipAll finishes as skipped at the current step', () => {
    const s = run({ type: 'next' }, { type: 'skipAll' })
    expect(s.finished).toBe('skipped')
    expect(finishPayload(s, 'skipped')).toEqual({ outcome: 'skipped', lastStep: 'permissions' })
  })

  it('complete finishes at done', () => {
    const s = run({ type: 'complete' })
    expect(s.finished).toBe('completed')
    expect(finishPayload(s, 'completed')).toEqual({ outcome: 'completed', lastStep: 'done' })
  })

  it('a finished flow ignores further actions', () => {
    const s = run({ type: 'skipAll' })
    expect(flowReducer(s, { type: 'next' })).toBe(s)
    expect(flowReducer(s, { type: 'restore' })).toBe(s)
  })

  it('minimise / restore keep the step (navigating away never traps or loses progress)', () => {
    const s = run({ type: 'next' }, { type: 'next' }, { type: 'minimize' })
    expect(s.minimized).toBe(true)
    expect(currentStep(s)).toBe('connections')
    const r = flowReducer(s, { type: 'restore' })
    expect(r.minimized).toBe(false)
    expect(currentStep(r)).toBe('connections')
    // Skipping from the minimised pill still works.
    expect(flowReducer(s, { type: 'skipAll' }).finished).toBe('skipped')
  })
})

describe('onboarding view-model', () => {
  it('permission rows are read-only status, unknown when capture status is missing', () => {
    expect(permissionRows(null).map((r) => r.tone)).toEqual(['subtle', 'subtle'])
    const rows = permissionRows({ permissions: { accessibility: true, screenRecording: false } } as never)
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['accessibility', 'Granted'],
      ['screenRecording', 'Not granted']
    ])
  })

  it('agent rows cover Claude Code / Codex / Cursor from the connections list', () => {
    expect(agentRows(undefined).map((r) => [r.id, r.label])).toEqual([
      ['claude-code', 'Status unknown'],
      ['codex', 'Status unknown'],
      ['cursor', 'Status unknown']
    ])
    const rows = agentRows({
      broker: { url: 'http://127.0.0.1:8750', running: true, error: null },
      agents: [
        { id: 'claude-code', name: 'Claude Code', state: 'connected' },
        { id: 'codex', name: 'Codex', state: 'available' },
        { id: 'claude-desktop', name: 'Claude Desktop', state: 'connected' },
        { id: 'cursor', name: 'Cursor', state: 'not_installed' }
      ]
    } as never)
    expect(rows.map((r) => [r.id, r.label, r.tone])).toEqual([
      ['claude-code', 'Connected', 'ok'],
      ['codex', 'Installed, not connected', 'warn'],
      ['cursor', 'Not installed', 'subtle']
    ])
  })

  it('done headline uses libraryHeadline with real counts', () => {
    const counts = { people: 4, projects: 2, unclassified: 1, skills: 3 }
    const h = doneHeadline({ counts } as never, null)
    expect(h).toEqual({ text: libraryHeadline(counts as never), tone: 'ok' })
    expect(h.text).toContain('2')
  })

  it('done headline is honest when the Runtime is offline (never a fake number)', () => {
    for (const code of ['unreachable', 'timeout', 'runtime_missing', 'token_unavailable', null]) {
      expect(doneHeadline(null, { code, message: 'x' }).text).toBe(runtimeOfflineHeadline())
    }
    expect(runtimeOfflineHeadline()).toBe("Runtime not connected; can't count yet")
    const other = doneHeadline(null, { code: 'schema', message: '坏数据' })
    expect(other.text).toBe("Can't count yet: 坏数据")
    expect(other.text).not.toMatch(/\d/)
    expect(doneHeadline(undefined, undefined).text).toBe('Counting…')
  })
})
