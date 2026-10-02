import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as Schema from 'effect/Schema'

import type { LedgerStore } from '../../store/ledger.js'
import { buildLedgerPrompts } from './prompts.js'
import { buildLedgerResources } from './resources.js'
import { buildLedgerTools } from './tools.js'

/** The `watchtower-ledger` MCP server (ADR 0020). The advanced SDK Server API
 *  owns protocol negotiation, request validation, framing, protocol errors,
 *  and transport shutdown. One handler per MCP primitive keeps handler
 *  ownership here while Effect Schemas validate application arguments and
 *  generate the advertised tool metadata. */
export function createLedgerMcpServer(store: LedgerStore): Server {
  const server = new Server(
    { name: 'watchtower-ledger', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  const tools = buildLedgerTools(store)
  const resources = buildLedgerResources(store)
  const prompts = buildLedgerPrompts()

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(tool => {
      const inputSchema = Schema.toStandardJSONSchemaV1(tool.inputSchema)['~standard'].jsonSchema.input({
        target: 'draft-2020-12',
      })
      return {
        name: tool.name,
        description: tool.description,
        // Every tool input is an Effect Struct. Add its known object marker to
        // the generated projection required by the MCP Tool protocol type.
        inputSchema: { ...inputSchema, type: 'object' },
      }
    }),
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(definition => definition.name === request.params.name)
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    try {
      const result = await tool.run(request.params.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool call failed' }],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: resources.map(({ name, uri, title, description, mimeType }) => ({
      name,
      uri,
      title,
      description,
      mimeType,
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, request => {
    const resource = resources.find(definition => definition.uri === request.params.uri)
    // Throw the SDK's protocol error so this remains JSON-RPC InvalidParams.
    // eslint-disable-next-line no-restricted-syntax
    if (!resource) throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`)
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.read() }],
    }
  })

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: prompts.map(({ name, title, description }) => ({ name, title, description, arguments: [] })),
  }))

  server.setRequestHandler(GetPromptRequestSchema, request => {
    const prompt = prompts.find(definition => definition.name === request.params.name)
    // Throw the SDK's protocol error so this remains JSON-RPC InvalidParams.
    // eslint-disable-next-line no-restricted-syntax
    if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`)
    return {
      messages: [{ role: 'user', content: { type: 'text', text: prompt.render() } }],
    }
  })

  return server
}
