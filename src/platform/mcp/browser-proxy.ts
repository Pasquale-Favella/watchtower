import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** Stdio-only Harnesses receive the same tool definitions and image results as HTTP clients. */
export function createBrowserMcpProxy(client: Client): Server {
  const server = new Server({ name: 'watchtower-browser', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => client.listTools({}, { signal: extra.signal }))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    client.callTool(request.params, CallToolResultSchema, { signal: extra.signal }),
  )
  return server
}
