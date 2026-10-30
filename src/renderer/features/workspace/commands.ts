import * as Effect from 'effect/Effect'
import { RpcClientError } from 'effect/rpc/RpcClientError'

/** Snapshot user intent once, outside the retry loop; callers must not reuse it for a new action. */
export function createWorkspaceIntent<Input extends object>(
  input: Input,
  commandId: () => string = () => crypto.randomUUID(),
): Input & { readonly commandId: string } {
  return { ...structuredClone(input), commandId: commandId() }
}

/** Only transport failures are replayable. Domain conflicts/stale commands require a new user decision. */
export const retryWorkspaceIntent = Effect.fnUntraced(function* <Input, Value, Error, Requirements, WaitRequirements>(
  intent: Input,
  send: (intent: Input) => Effect.Effect<Value, Error, Requirements>,
  reconnect: Effect.Effect<void, never, WaitRequirements>,
) {
  let retries = 0
  while (true) {
    const result = yield* Effect.result(Effect.suspend(() => send(intent)))
    if (result._tag === 'Success') return result.success
    if (!(result.failure instanceof RpcClientError) || retries >= 3) return yield* Effect.fail(result.failure)
    retries++
    yield* reconnect
  }
})
