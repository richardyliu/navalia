import { describe, expect, it } from 'vitest'
import { assessorNote, waitingReason } from '../../src/main/het/weekly'

describe('S1-02 weekly export is honest about the assessor gate', () => {
  it('says the total is not a measurement when the assessor is disabled or has no transport', () => {
    expect(assessorNote({ state: 'disabled' })).toMatch(/not enabled.*not a measurement/)
    expect(assessorNote({ state: 'no_transport' })).toMatch(/no assessor transport.*not a measurement/)
    expect(assessorNote({ state: 'budget_unavailable' })).toMatch(/budget unavailable/)
    expect(assessorNote({ state: 'fixture' })).toMatch(/fixture/)
  })

  it('adds no note when the assessor is ready or status is unknown', () => {
    expect(assessorNote({ state: 'ready' })).toBeNull()
    expect(assessorNote(undefined)).toBeNull()
  })

  it('explains gated waiting tasks instead of calling them errors', () => {
    expect(waitingReason({ status: 'needs_assessment', last_error: 'assessor_disabled' } as never)).toMatch(/disabled by the user setting/)
    expect(waitingReason({ status: 'needs_assessment', last_error: 'no_transport' } as never)).toMatch(/no assessor transport/)
    expect(waitingReason({ status: 'needs_assessment', last_error: 'assessor_disabled' } as never)).not.toMatch(/error/)
  })
})
