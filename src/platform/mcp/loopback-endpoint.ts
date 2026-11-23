import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import { AgentDriverError } from '@/core/ports/agent-driver.js'
import { handleMcpHttpRequest } from '@/platform/mcp/http-server.js'

export interface LoopbackMcpEndpoint {
  readonly url: string
  readonly token: string
}

/**
 * One ephemeral, bearer-authenticated MCP endpoint on 127.0.0.1. A fresh MCP server answers each request and shares
 * the abort signal, so a released endpoint stops serving at once. The finalizer aborts, runs `release`, and closes
 * every connection. Both the browser and the orchestrator endpoints use this helper.
 */
export const acquireLoopbackMcp = Effect.fn('acquireLoopbackMcp')(function* (options: {
  readonly createServer: (signal: AbortSignal) => Server
  readonly runRequest: (request: Effect.Effect<void>) => Promise<void>
  readonly release?: (() => Promise<void>) | undefined
  readonly startFailure: string
}): Effect.fn.Return<LoopbackMcpEndpoint, AgentDriverError, Scope.Scope> {
  const token = randomBytes(32).toString('hex')
  const controller = new AbortController()
  const http = createServer((req, res) => {
    if (controller.signal.aborted) {
      res.writeHead(410).end()
      return
    }
    void options
      .runRequest(handleMcpHttpRequest(req, res, token, () => options.createServer(controller.signal)))
      .catch(() => res.destroy())
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      controller.abort()
      if (options.release) {
        const release = options.release
        yield* Effect.promise(() => release())
      }
      http.closeAllConnections()
      yield* Effect.callback<undefined>(resume => {
        http.close(() => resume(Effect.succeed(undefined)))
      })
    }),
  )
  yield* Effect.callback<undefined, AgentDriverError>(resume => {
    const failed = () =>
      resume(Effect.fail(new AgentDriverError({ code: 'invalid-state', message: options.startFailure })))
    http.once('error', failed)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', failed)
      resume(Effect.succeed(undefined))
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string')
    return yield* new AgentDriverError({ code: 'invalid-state', message: options.startFailure })
  return { url: `http://127.0.0.1:${address.port}/mcp`, token }
})
