import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'

const logPath = process.argv[2]
const prompts = new Map()
const permissions = new Map()

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}

function reply(id, result) {
  send({ id, result })
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } })
}

function finish(sessionId, stopReason) {
  const id = prompts.get(sessionId)
  if (id === undefined) return
  prompts.delete(sessionId)
  reply(id, { stopReason })
}

createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') {
    reply(frame.id, {
      protocolVersion: frame.params.protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
      agentInfo: { name: 'workspace-fixture', version: '1' },
      authMethods: [],
    })
  } else if (frame.method === 'session/new') {
    reply(frame.id, {
      sessionId: `fixture-${randomUUID()}`,
      models: {
        currentModelId: 'fixture-model',
        availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }],
      },
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    })
  } else if (frame.method === 'session/load') {
    reply(frame.id, {
      models: {
        currentModelId: 'fixture-model',
        availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }],
      },
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    })
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model') {
    appendFileSync(logPath, `${JSON.stringify({ kind: frame.method, params: frame.params })}\n`)
    reply(frame.id, {})
  } else if (frame.method === 'session/prompt') {
    const { sessionId, prompt } = frame.params
    appendFileSync(logPath, `${JSON.stringify({ kind: 'prompt', sessionId, prompt })}\n`)
    prompts.set(sessionId, frame.id)
    update(sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'fixture-check', description: 'Check this fixture', input: { hint: 'Instructions' } },
      ],
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I will inspect this checkout.' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'fixture-read',
      title: 'Read README',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'README.md' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fixture-read',
      status: 'completed',
      rawOutput: 'Fixture repository',
    })
    const requestId = `permission-${randomUUID()}`
    permissions.set(requestId, sessionId)
    send({
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'fixture-command', title: 'Inspect checkout status' },
        options: [
          { optionId: 'fixture-read-once', name: 'Inspect once', kind: 'allow_once' },
          { optionId: 'fixture-reject', name: 'Skip inspection', kind: 'reject_once' },
        ],
      },
    })
  } else if (frame.method === 'session/cancel') {
    appendFileSync(logPath, `${JSON.stringify({ kind: 'cancel', sessionId: frame.params.sessionId })}\n`)
    finish(frame.params.sessionId, 'cancelled')
  } else if (permissions.has(frame.id)) {
    const sessionId = permissions.get(frame.id)
    permissions.delete(frame.id)
    appendFileSync(logPath, `${JSON.stringify({ kind: 'decision', result: frame.result })}\n`)
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Checkout inspection finished.' },
    })
    finish(sessionId, frame.result?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn')
  } else if (frame.id !== undefined && frame.method) {
    send({ id: frame.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
})
