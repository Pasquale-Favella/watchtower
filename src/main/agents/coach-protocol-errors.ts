import * as Cause from 'effect/Cause'

import { CoachSdkFailure, coachSdkFailureMessage } from './coach-errors.js'

/** Maps failures only at the renderer protocol boundary. */
export function coachProtocolError(error: unknown): string {
  if (error instanceof CoachSdkFailure) return coachSdkFailureMessage('The agent', error)
  if (Cause.isCause(error)) {
    if (Cause.hasInterruptsOnly(error)) return 'The Coach request was interrupted.'
    if (error.reasons.every(Cause.isFailReason)) {
      for (const reason of error.reasons) {
        if (Cause.isFailReason(reason) && reason.error instanceof CoachSdkFailure) {
          return coachSdkFailureMessage('The agent', reason.error)
        }
      }
    }
  }
  return 'An unexpected Coach failure occurred. Please retry.'
}
