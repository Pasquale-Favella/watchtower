import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { expect, it } from 'vitest'

import { LocalLedgerMcp, localLedgerMcpLayer } from '@/platform/mcp/local-ledger-mcp.js'
import { createLedgerMcpQueries } from '@/platform/mcp/query-api.js'

it('starts Local MCP on demand, shares concurrent connections, and invalidates copied credentials on rotation', async () => {
  const runtime = ManagedRuntime.make(localLedgerMcpLayer(Effect.runPromise))
  const queries = createLedgerMcpQueries({ request: async () => undefined })
  try {
    const local = await runtime.runPromise(LocalLedgerMcp)
    expect(await runtime.runPromise(local.status())).toBeNull()

    const [first, second] = await Promise.all([
      runtime.runPromise(local.connection(queries)),
      runtime.runPromise(local.connection(queries)),
    ])
    expect(first).toBe(second)
    if (!first) throw new Error('Expected the local ledger endpoint')
    expect(await runtime.runPromise(local.status())).toBe(first)
    const previous = first
    const rotated = await runtime.runPromise(local.regenerate(queries))
    if (!rotated) throw new Error('Expected a rotated ledger endpoint')
    expect(rotated.token).not.toBe(previous.token)
    if (previous.url !== rotated.url) await expect(fetch(previous.url)).rejects.toBeDefined()
    expect((await fetch(rotated.url, { headers: { Authorization: `Bearer ${previous.token}` } })).status).toBe(401)
    const healthUrl = new URL('/health', rotated.url)
    expect((await fetch(healthUrl, { headers: { Authorization: `Bearer ${rotated.token}` } })).status).toBe(200)

    await runtime.runPromise(local.shutdown())
    await expect(fetch(healthUrl)).rejects.toBeDefined()
    expect(await runtime.runPromise(Effect.all([local.status(), local.connection(queries)]))).toEqual([null, null])
  } finally {
    await runtime.dispose()
  }
})
