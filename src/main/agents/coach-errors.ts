import * as Schema from 'effect/Schema'

/** An expected failure raised by the external ACP / AI SDK boundary. Raw
 *  provider text is deliberately excluded so it cannot leak through Coach. */
export class CoachSdkFailure extends Schema.TaggedError<CoachSdkFailure>()('CoachSdkFailure', {
  stage: Schema.Literals([
    'sdk-load',
    'provider-create',
    'session-init',
    'selection',
    'stream-create',
    'stream-next',
    'inspection',
  ]),
  reason: Schema.Literals(['rejected', 'timeout', 'cancelled']),
  authentication: Schema.Boolean,
}) {}

export type CoachSdkFailureStage = CoachSdkFailure['stage']
export type CoachSdkFailureReason = CoachSdkFailure['reason']

/** Stable, bounded description suitable for IPC and CoachEvent messages. */
export function coachSdkFailureMessage(displayName: string, failure: CoachSdkFailure, authHint?: string): string {
  if (failure.reason === 'cancelled') return `${displayName} inspection was cancelled.`
  if (failure.reason === 'timeout') return `${displayName} did not answer the session inspection in time.`
  if (failure.authentication)
    return authHint ?? `${displayName} sign-in required. Sign in with the harness's own CLI, then retry.`
  switch (failure.stage) {
    case 'sdk-load':
      return `${displayName} integration could not be loaded. Check the installation and try again.`
    case 'provider-create':
      return `${displayName} could not be started. Check that it is installed and try again.`
    case 'session-init':
    case 'inspection':
      return `${displayName} could not complete its session handshake. Check the installation and try again.`
    case 'selection':
      return `${displayName} could not apply the selected model or mode. Refresh the selection and try again.`
    case 'stream-create':
    case 'stream-next':
      return `${displayName} could not complete the request. Check its sign-in and try again.`
  }
}
