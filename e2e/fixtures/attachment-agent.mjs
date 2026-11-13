import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}

createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        protocolVersion: frame.params.protocolVersion,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: 'attachment-fixture', version: '1' },
        authMethods: [],
      },
    })
  } else if (frame.method === 'session/new' || frame.method === 'session/load') {
    send({
      id: frame.id,
      result: {
        sessionId: frame.params.sessionId ?? randomUUID(),
        models: {
          currentModelId: 'attachment-model',
          availableModels: [{ modelId: 'attachment-model', name: 'Attachment fixture' }],
        },
      },
    })
  } else if (frame.method === 'session/prompt') {
    appendFileSync(
      process.argv[2],
      `${JSON.stringify({
        kind: 'prompt',
        images: frame.params.prompt.filter(item => item.type === 'image').length,
        text: frame.params.prompt
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n'),
      })}\n`,
    )
    send({
      method: 'session/update',
      params: {
        sessionId: frame.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Attachments received.' } },
      },
    })
    send({ id: frame.id, result: { stopReason: 'end_turn' } })
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model') {
    send({ id: frame.id, result: {} })
  } else if (frame.id !== undefined && frame.method) {
    send({ id: frame.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
})
