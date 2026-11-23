import { expect, it } from 'vitest'

import { makeMainRuntime } from '@/platform/electron/main/main-runtime.js'
import { LocalLedgerMcp } from '@/platform/mcp/local-ledger-mcp.js'
import { createLedgerMcpQueries } from '@/platform/mcp/query-api.js'

it('closes the app-owned ledger MCP listener when the main runtime is disposed', async () => {
  const runtime = makeMainRuntime(
    { clientVersion: '1.0.0', appPath: '/app', onHarnessChange: () => {} },
    { detect: async () => [] },
  )
  let healthUrl: URL
  try {
    const local = await runtime.runPromise(LocalLedgerMcp)
    const endpoint = await runtime.runPromise(
      local.connection(createLedgerMcpQueries({ request: async () => undefined })),
    )
    if (!endpoint) throw new Error('Expected the local ledger endpoint')
    healthUrl = new URL('/health', endpoint.url)
    const response = await fetch(healthUrl, { headers: { Authorization: `Bearer ${endpoint.token}` } })
    expect(response.status).toBe(200)
  } finally {
    await runtime.dispose()
  }

  await expect(fetch(healthUrl)).rejects.toBeDefined()
})
