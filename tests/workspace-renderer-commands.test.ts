import * as Effect from 'effect/Effect'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import { describe, expect, it } from 'vitest'

import { createWorkspaceIntent, retryWorkspaceIntent } from '../src/renderer/features/workspace/commands.js'
import { WorkspaceRpcError } from '../src/shared/rpc/workspace.js'

const disconnected = new RpcClientError({ reason: new RpcClientDefect({ message: 'Disconnected', cause: undefined }) })

describe('workspace command intent', () => {
  it('reuses one commandId and payload after reconnect but generates a new ID for a new intent', async () => {
    let next = 0
    const id = () => `command-${++next}`
    const input = { prompt: 'original' }
    const intent = createWorkspaceIntent(input, id)
    input.prompt = 'changed'
    const observed: string[] = []
    let waits = 0
    const result = await Effect.runPromise(
      retryWorkspaceIntent(
        intent,
        request => {
          observed.push(`${request.commandId}:${request.prompt}`)
          return observed.length === 1 ? Effect.fail(disconnected) : Effect.succeed('receipt')
        },
        Effect.sync(() => {
          waits++
        }),
      ),
    )
    expect(result).toBe('receipt')
    expect(observed).toEqual(['command-1:original', 'command-1:original'])
    expect(waits).toBe(1)
    expect(createWorkspaceIntent(input, id).commandId).toBe('command-2')
  })

  it('never retries a conflict or a stale domain command', async () => {
    for (const code of ['conflict', 'stale'] as const) {
      let attempts = 0
      const result = await Effect.runPromise(
        Effect.result(
          retryWorkspaceIntent(
            createWorkspaceIntent({}, () => 'intent'),
            () => {
              attempts++
              return Effect.fail(
                new WorkspaceRpcError({ code, message: 'Workspace command conflicts with existing state.' }),
              )
            },
            Effect.void,
          ),
        ),
      )
      expect(result._tag).toBe('Failure')
      expect(attempts).toBe(1)
    }
  })

  it('bounds automatic retries instead of looping forever', async () => {
    let attempts = 0
    const result = await Effect.runPromise(
      Effect.result(
        retryWorkspaceIntent(
          createWorkspaceIntent({}, () => 'intent'),
          () => {
            attempts++
            return Effect.fail(disconnected)
          },
          Effect.void,
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(attempts).toBe(4)
  })
})
