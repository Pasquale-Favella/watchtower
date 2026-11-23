import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

/** Stdio-only Harnesses receive the same tool definitions and image results as HTTP clients. */
export function createBrowserMcpProxy(client: Client, serverName: string = 'watchtower-browser'): Server {
  const hasLedgerContent = serverName === 'watchtower-ledger'
  const server = new Server(
    { name: serverName, version: '1.0.0' },
    { capabilities: { tools: {}, ...(hasLedgerContent ? { resources: {}, prompts: {} } : {}) } },
  )
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => client.listTools({}, { signal: extra.signal }))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    client.callTool(request.params, CallToolResultSchema, { signal: extra.signal }),
  )
  if (hasLedgerContent) {
    server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
      client.listResources(request.params, { signal: extra.signal }),
    )
    server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
      client.readResource(request.params, { signal: extra.signal }),
    )
    server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
      client.listPrompts(request.params, { signal: extra.signal }),
    )
    server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
      client.getPrompt(request.params, { signal: extra.signal }),
    )
  }
  return server
}
