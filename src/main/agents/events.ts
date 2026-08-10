import type { StreamChunk } from '@tanstack/ai'
import type { CoachEvent } from '../../shared/schemas/agents.js'

/**
 * AG-UI chunk → CoachEvent derivation (ticket 20 / ADR 0005). A coding-agent
 * harness streams AG-UI chunks (RUN_STARTED, TEXT_MESSAGE_CONTENT,
 * TOOL_CALL_START, CUSTOM, …); the HarnessRuntime seam maps each chunk to the
 * typed event union the renderer consumes. Pure and stateless — one chunk in,
 * zero or one event out — so the mapping is unit-testable without any harness
 * installed. Session-resume handles surface as the harness's session-id custom
 * events (claude-code.session-id / opencode.session-id / codex.session-id).
 */
const SESSION_ID_EVENTS = new Set([
  'claude-code.session-id',
  'opencode.session-id',
  'codex.session-id',
])

export function deriveCoachEvents(chunk: StreamChunk): CoachEvent[] {
  switch (chunk.type) {
    case 'RUN_STARTED':
      return [{ kind: 'status', state: 'starting' }]
    case 'RUN_FINISHED':
      return [{ kind: 'status', state: 'done' }]
    case 'RUN_ERROR':
      return [{ kind: 'error', message: chunk.message }]
    case 'TEXT_MESSAGE_CONTENT':
      // Skip empty deltas — they carry no text and would spam the event stream.
      return chunk.delta ? [{ kind: 'text', delta: chunk.delta }] : []
    case 'TOOL_CALL_START':
      return [{ kind: 'tool', tool: chunk.toolCallName ?? chunk.toolName }]
    case 'CUSTOM':
      if (SESSION_ID_EVENTS.has(chunk.name)) {
        return [{ kind: 'session', sessionId: String(chunk.value) }]
      }
      return []
    default:
      // Thinking steps, snapshots, state deltas, tool-call args/ends, … are not
      // part of the CoachEvent surface.
      return []
  }
}
