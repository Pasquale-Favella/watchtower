import { describe, expect, it } from 'vitest'

import { CoachSdkFailure, coachSdkFailureMessage } from '../src/main/agents/coach-errors.js'

describe('CoachSdkFailure', () => {
  it('keeps SDK failure metadata finite and excludes provider details', () => {
    const failure = new CoachSdkFailure({
      stage: 'session-init',
      reason: 'rejected',
      authentication: false,
    })

    expect(failure).toMatchObject({
      _tag: 'CoachSdkFailure',
      stage: 'session-init',
      reason: 'rejected',
      authentication: false,
    })
    expect(Object.keys(failure).sort()).toEqual(['_tag', 'authentication', 'reason', 'stage'])
    expect(coachSdkFailureMessage('Claude Code', failure)).toBe(
      'Claude Code could not complete its session handshake. Check the installation and try again.',
    )
  })

  it('distinguishes an inspection timeout from cancellation', () => {
    const timeout = new CoachSdkFailure({ stage: 'inspection', reason: 'timeout', authentication: false })
    const cancelled = new CoachSdkFailure({ stage: 'inspection', reason: 'cancelled', authentication: false })

    expect(coachSdkFailureMessage('Claude Code', timeout)).toBe(
      'Claude Code did not answer the session inspection in time.',
    )
    expect(coachSdkFailureMessage('Claude Code', cancelled)).toBe('Claude Code inspection was cancelled.')
    expect(coachSdkFailureMessage('Claude Code', timeout)).not.toBe(coachSdkFailureMessage('Claude Code', cancelled))
  })

  it('projects authentication failures to a finite sign-in instruction', () => {
    const failure = new CoachSdkFailure({ stage: 'stream-next', reason: 'rejected', authentication: true })

    expect(coachSdkFailureMessage('Codex', failure)).toBe(
      "Codex sign-in required. Sign in with the harness's own CLI, then retry.",
    )
  })

  it('provides a finite message for SDK loading failure', () => {
    const failure = new CoachSdkFailure({ stage: 'sdk-load', reason: 'rejected', authentication: false })

    expect(coachSdkFailureMessage('Codex', failure)).toBe(
      'Codex integration could not be loaded. Check the installation and try again.',
    )
  })
})
