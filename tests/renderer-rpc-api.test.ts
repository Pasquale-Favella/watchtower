import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { RpcClient, RpcGroup, RpcServer } from 'effect/rpc'
import { describe, expect, it } from 'vitest'

import { GetSession } from '../src/shared/rpc/analytics.js'
import { clientProtocolLayer, serverProtocolLayer } from '../src/shared/rpc/port-protocol.js'
import { makeMemoryRpcPorts } from './memory-rpc-ports.js'

const sessionRpcGroup = RpcGroup.make(GetSession)

describe('generated renderer RPC over the production port protocol', () => {
  it('keeps nullable success distinct from invalid success and releases the transport', async () => {
    const [clientPort, serverPort, states] = makeMemoryRpcPorts()
    const handlers = sessionRpcGroup.toLayer(
      sessionRpcGroup.of({
        'store:session': ({ sessionId }) =>
          Effect.succeed(
            sessionId === 'nullable' ? null : ({ privatePrompt: 'must not cross the RPC boundary' } as never),
          ),
      }),
    )
    const server = RpcServer.layer(sessionRpcGroup, { disableTracing: true }).pipe(
      Layer.provide(Layer.merge(serverProtocolLayer(serverPort), handlers)),
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(sessionRpcGroup)
          const nullable = yield* client['store:session']({ sessionId: 'nullable' })
          const invalid = yield* Effect.exit(client['store:session']({ sessionId: 'invalid' }))
          return { nullable, invalid }
        }),
      ).pipe(Effect.provide(Layer.merge(clientProtocolLayer(clientPort), server))),
    )

    expect(result.nullable).toBeNull()
    expect(Exit.isFailure(result.invalid)).toBe(true)
    expect(JSON.stringify(result.invalid)).not.toContain('must not cross the RPC boundary')
    expect(states[0].sent.every(frame => typeof frame === 'string')).toBe(true)
    expect(states[0].receivers.size).toBe(0)
    expect(states[1].receivers.size).toBe(0)
  })
})
