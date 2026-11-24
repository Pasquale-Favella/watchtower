import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { URL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const stdioOnly = process.argv.includes('--stdio')
const logPath = process.argv[stdioOnly ? 3 : 2]
const sessions = new Map()
function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}
function log(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`)
}

async function inspectBrowser(frame) {
  const { sessionId, prompt } = frame.params
  const promptText = prompt
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
  if (promptText.includes('<browser-annotation ')) {
    log({ kind: 'annotation-received', text: promptText, images: prompt.filter(part => part.type === 'image').length })
    send({ id: frame.id, result: { stopReason: 'end_turn' } })
    return
  }
  const descriptor = sessions.get(sessionId)
  const url = prompt
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join(' ')
    .match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
  if (!descriptor || !url) throw new Error('Browser MCP context was not supplied to the fixture.')
  const client = new Client({ name: 'watchtower-browser-fixture', version: '1' })
  const environment = Object.fromEntries((descriptor.env ?? []).map(item => [item.name, item.value]))
  const transport = descriptor.url
    ? new StreamableHTTPClientTransport(new URL(descriptor.url), {
        requestInit: { headers: Object.fromEntries(descriptor.headers.map(header => [header.name, header.value])) },
      })
    : new StdioClientTransport({
        command: descriptor.command,
        args: descriptor.args,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
          ...environment,
        },
      })
  await client.connect(transport)
  try {
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
      return result
    }
    const opened = await call('preview_open', { url })
    const tabId = JSON.parse(opened.content[0].text).tabId
    await call('preview_wait_for', { tabId, selector: '#name' })
    const first = await call('preview_snapshot', { tabId })
    const snapshot = JSON.parse(first.content.find(item => item.type === 'text').text)
    const input = snapshot.interactiveElements.find(item => item.tag === 'input')
    await call('preview_act', { tabId, action: 'type', ref: input.ref, text: 'Browser agent' })
    await call('preview_act', { tabId, action: 'click', selector: '#greet' })
    await call('preview_wait_for', {
      tabId,
      expression: 'document.querySelector("#result").textContent === "Hello Browser agent"',
    })
    await call('preview_resize', { tabId, width: 390, height: 844 })
    await call('preview_set_appearance', { tabId, colorScheme: 'dark' })
    const final = await call('preview_snapshot', { tabId, includeImage: true })
    const text = final.content.find(item => item.type === 'text').text
    const image = final.content.find(item => item.type === 'image')
    const evaluated = await call('preview_evaluate', {
      tabId,
      expression: '({width:innerWidth,dark:matchMedia("(prefers-color-scheme: dark)").matches})',
    })
    log({
      kind: 'browser-complete',
      tabId,
      url: descriptor.url ?? environment.WATCHTOWER_BROWSER_MCP_URL,
      transport: descriptor.url ? 'http' : 'stdio',
      snapshot: JSON.parse(text),
      screenshot: Boolean(image?.data),
      evaluated: JSON.parse(evaluated.content[0].text),
    })
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Browser interaction verified.' },
        },
      },
    })
    send({ id: frame.id, result: { stopReason: 'end_turn' } })
  } finally {
    await client.close()
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        protocolVersion: frame.params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: !stdioOnly },
        },
        agentInfo: { name: 'browser-fixture', version: '1' },
        authMethods: [],
      },
    })
  } else if (frame.method === 'session/new' || frame.method === 'session/load') {
    const sessionId = frame.params.sessionId ?? `browser-${randomUUID()}`
    sessions.set(
      sessionId,
      frame.params.mcpServers.find(server => server.name === 'watchtower-browser'),
    )
    send({
      id: frame.id,
      result: {
        sessionId,
        models: {
          currentModelId: 'browser-model',
          availableModels: [{ modelId: 'browser-model', name: 'Browser fixture model' }],
        },
      },
    })
  } else if (frame.method === 'session/prompt') {
    void inspectBrowser(frame).catch(error => {
      log({ kind: 'browser-error', message: error.message })
      send({ id: frame.id, error: { code: -32603, message: error.message } })
    })
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model') {
    send({ id: frame.id, result: {} })
  } else if (frame.id !== undefined && frame.method) {
    send({ id: frame.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
})
