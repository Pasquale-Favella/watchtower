import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@tanstack/ai'

import { deriveCoachEvents } from '../src/main/agents/events.js'

/** Build a minimal AG-UI chunk fixture of the given type. */
function chunk(type: string, extra: Record<string, unknown> = {}): StreamChunk {
  return { type, ...extra } as unknown as StreamChunk
}

describe('deriveCoachEvents — AG-UI chunk → CoachEvent (seam: pure logic)', () => {
  it('maps RUN_STARTED to a starting status event', () => {
    expect(deriveCoachEvents(chunk('RUN_STARTED', { threadId: 't1', runId: 'r1' }))).toEqual([
      { kind: 'status', state: 'starting' },
    ])
  })

  it('maps RUN_FINISHED to a done status event', () => {
    expect(deriveCoachEvents(chunk('RUN_FINISHED', { threadId: 't1', runId: 'r1' }))).toEqual([
      { kind: 'status', state: 'done' },
    ])
  })

  it('maps RUN_ERROR to an error event carrying the message', () => {
    expect(deriveCoachEvents(chunk('RUN_ERROR', { message: 'credential wall', code: 'E_AUTH' }))).toEqual([
      { kind: 'error', message: 'credential wall' },
    ])
  })

  it('maps a TEXT_MESSAGE_CONTENT delta to a text event', () => {
    expect(deriveCoachEvents(chunk('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'Hello ' }))).toEqual([
      { kind: 'text', delta: 'Hello ' },
    ])
  })

  it('ignores empty text deltas', () => {
    expect(deriveCoachEvents(chunk('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: '' }))).toEqual([])
  })

  it('maps TOOL_CALL_START to a tool event using toolCallName', () => {
    expect(deriveCoachEvents(chunk('TOOL_CALL_START', { toolCallId: 'tc1', toolCallName: 'Bash' }))).toEqual([
      { kind: 'tool', tool: 'Bash' },
    ])
  })

  it('falls back to the deprecated toolName field when toolCallName is absent', () => {
    expect(deriveCoachEvents(chunk('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'Read' }))).toEqual([
      { kind: 'tool', tool: 'Read' },
    ])
  })

  it('maps the claude-code session-id custom event to a session event', () => {
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'claude-code.session-id', value: 'sess_123' }))).toEqual([
      { kind: 'session', sessionId: 'sess_123' },
    ])
  })

  it('maps the opencode session-id custom event to a session event', () => {
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'opencode.session-id', value: 'ses_abc' }))).toEqual([
      { kind: 'session', sessionId: 'ses_abc' },
    ])
  })

  it('maps the codex session-id custom event to a session event', () => {
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'codex.session-id', value: 'codex_9' }))).toEqual([
      { kind: 'session', sessionId: 'codex_9' },
    ])
  })

  it('ignores non-session custom events (sandbox.file, todo, etc.)', () => {
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'sandbox.file', value: { path: 'a.ts' } }))).toEqual([])
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'todo', value: [] }))).toEqual([])
  })

  it('ignores uninteresting chunk types (thinking, snapshots)', () => {
    expect(deriveCoachEvents(chunk('STEP_STARTED', { stepName: 'thinking' }))).toEqual([])
    expect(deriveCoachEvents(chunk('MESSAGES_SNAPSHOT', { messages: [] }))).toEqual([])
    expect(deriveCoachEvents(chunk('STATE_DELTA', { delta: [] }))).toEqual([])
  })

  it('coerces a non-string session-id value to a string', () => {
    expect(deriveCoachEvents(chunk('CUSTOM', { name: 'claude-code.session-id', value: 42 }))).toEqual([
      { kind: 'session', sessionId: '42' },
    ])
  })
})
