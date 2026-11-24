import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { acquireLoopbackMcp } from '@/platform/mcp/loopback-endpoint.js'

const newServer = () => new Server({ name: 'loopback-test', version: '1.0.0' }, { capabilities: { tools: {} } })

const endpointOptions = {
  createServer: () => newServer(),
  runRequest: (request: Effect.Effect<void>) => Effect.runPromise(request),
  startFailure: 'The test endpoint could not start.',
}

const healthOf = (url: string) => url.replace(/\/mcp$/, '/health')

describe('loopback MCP endpoint', () => {
  it('listens on 127.0.0.1 with a fresh 256-bit bearer token', async () => {
    const endpoint = await Effect.runPromise(Effect.scoped(acquireLoopbackMcp(endpointOptions)))
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('answers only requests that carry the endpoint token', async () => {
    const statuses = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* acquireLoopbackMcp(endpointOptions)
          const authorized = yield* Effect.promise(() =>
            fetch(healthOf(endpoint.url), { headers: { Authorization: `Bearer ${endpoint.token}` } }),
          )
          const missing = yield* Effect.promise(() => fetch(healthOf(endpoint.url)))
          const wrong = yield* Effect.promise(() =>
            fetch(healthOf(endpoint.url), { headers: { Authorization: 'Bearer not-the-token' } }),
          )
          return { authorized: authorized.status, missing: missing.status, wrong: wrong.status }
        }),
      ),
    )
    expect(statuses).toEqual({ authorized: 200, missing: 401, wrong: 401 })
  })

  it('routes every request through the supplied runner', async () => {
    let runs = 0
    const options = {
      ...endpointOptions,
      runRequest: (request: Effect.Effect<void>) => {
        runs += 1
        return Effect.runPromise(request)
      },
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* acquireLoopbackMcp(options)
          yield* Effect.promise(() =>
            fetch(healthOf(endpoint.url), { headers: { Authorization: `Bearer ${endpoint.token}` } }),
          )
        }),
      ),
    )
    expect(runs).toBeGreaterThanOrEqual(1)
  })

  it('gives each endpoint its own port and token', async () => {
    const [first, second] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* acquireLoopbackMcp(endpointOptions)
          const b = yield* acquireLoopbackMcp(endpointOptions)
          return [a, b] as const
        }),
      ),
    )
    expect(first.url).not.toBe(second.url)
    expect(first.token).not.toBe(second.token)
  })

  it('stops serving and runs its release hook when the owning scope closes', async () => {
    let released = 0
    let url = ''
    let token = ''
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* acquireLoopbackMcp({
            ...endpointOptions,
            release: () => {
              released += 1
              return Promise.resolve()
            },
          })
          url = endpoint.url
          token = endpoint.token
        }),
      ),
    )
    expect(released).toBe(1)
    await expect(fetch(healthOf(url), { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow()
  })
})
