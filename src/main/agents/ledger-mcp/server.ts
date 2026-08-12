import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { LedgerStore } from '../../store/ledger.js'
import { buildLedgerPrompts } from './prompts.js'
import { buildLedgerResources } from './resources.js'
import { buildLedgerTools } from './tools.js'

/**
 * The `watchtower-ledger` MCP server (ADR 0020): the official
 * `@modelcontextprotocol/sdk` `McpServer` with the shared-seam tools,
 * resources, and prompts registered — the full MCP primitive set. Exported
 * as a factory so the CLI entry (`entry.ts`) and the in-memory integration
 * tests share the exact same wiring. The server speaks the full protocol
 * (initialize negotiation, tools/list, resources/list, prompts/list,
 * tools/call, resources/read, prompts/get, ping, error codes) — no
 * hand-rolled JSON-RPC (map 53's protocol.ts is gone).
 *
 * The server serves the FULL lifetime ledger — nothing is baked at spawn.
 * Each tool takes an optional `scope` argument (shared `overviewScopeSchema`)
 * so the harness filters autonomously; absent means the lifetime window.
 *
 * Tool outputs are JSON-text payloads that ARE the renderer's own shared
 * schema shapes; the SDK's zod input typing doubles as the wire contract.
 * Resources are passive documents behind stable URIs (`ledger://scope`,
 * `ledger://overview`, `ledger://schema`), and the `coach-orient` prompt is
 * the dual-scope briefing (coaching + skill authoring) — all reusing the same
 * seam and the same main-side prompt builders, so no MCP surface can drift
 * from the UI or from what a `coach:run` would send.
 */
export function createLedgerMcpServer(store: LedgerStore): McpServer {
  const server = new McpServer(
    { name: 'watchtower-ledger', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  for (const tool of buildLedgerTools(store)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // The run returns the shared payload object; the server serializes it
      // as the MCP text content. A throw surfaces as an isError result via the
      // SDK — never a protocol-level failure.
      async args => ({
        content: [{ type: 'text', text: JSON.stringify(await tool.run(args as Record<string, unknown>), null, 2) }],
      }),
    )
  }
  for (const resource of buildLedgerResources(store)) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async () => ({ contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.read() }] }),
    )
  }
  for (const prompt of buildLedgerPrompts()) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      // The render returns the user-facing text as a single user message — the
      // standard MCP prompt shape the client can splice into a conversation.
      async args => ({
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: prompt.render((args ?? {}) as Record<string, unknown>) },
        }],
      }),
    )
  }
  return server
}
