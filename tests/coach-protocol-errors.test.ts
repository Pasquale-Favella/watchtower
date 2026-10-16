import * as Cause from 'effect/Cause'
import { describe, expect, it } from 'vitest'

import { CoachSdkFailure } from '../src/main/agents/coach-errors.js'
import { coachProtocolError } from '../src/main/agents/coach-protocol-errors.js'

describe('Coach protocol error messages', () => {
  it('maps expected SDK failures without raw native rejection text', () => {
    expect(
      coachProtocolError(new CoachSdkFailure({ stage: 'session-init', reason: 'rejected', authentication: false })),
    ).toBe('The agent could not complete its session handshake. Check the installation and try again.')
    expect(
      coachProtocolError(new CoachSdkFailure({ stage: 'inspection', reason: 'timeout', authentication: false })),
    ).toBe('The agent did not answer the session inspection in time.')
  })

  it('keeps interruption distinct from an unexpected failure', () => {
    expect(coachProtocolError(Cause.interrupt(7))).toBe('The Coach request was interrupted.')
    expect(coachProtocolError(Cause.die(new Error('private defect')))).toBe(
      'An unexpected Coach failure occurred. Please retry.',
    )
  })

  it('maps a tagged failure in Cause without treating a tagged defect as expected', () => {
    const failure = new CoachSdkFailure({ stage: 'provider-create', reason: 'rejected', authentication: false })
    expect(coachProtocolError(Cause.fail(failure))).toBe(
      'The agent could not be started. Check that it is installed and try again.',
    )
    expect(coachProtocolError(Cause.die(failure))).toBe('An unexpected Coach failure occurred. Please retry.')
  })

  it.each([
    new Error('private prompt and C:\\Users\\person\\binary.exe'),
    { secret: 'private data' },
    'private rejection',
  ])('bounds unclassified protocol failures', error => {
    expect(coachProtocolError(error)).toBe('An unexpected Coach failure occurred. Please retry.')
  })
})
