import type { CoachEvent } from '../../shared/schemas/agents.js'

/**
 * AI SDK stream-part → CoachEvent derivation (ticket 20 / ADR 0005, revised
 * for the AI SDK pivot). The ACP provider (`@mcpc-tech/acp-ai-provider`)
 * bridges an ACP agent to the AI SDK's `LanguageModel`, so `streamText()`
 * yields AI SDK stream parts — not raw AG-UI chunks. The HarnessRuntime seam
 * maps each part to the typed event union the renderer consumes. Pure and
 * stateless — one part in, zero or one event out — so the mapping is
 * unit-testable without any harness installed.
 *
 * Session-resume handles are NOT derived here anymore: with ACP, the session
 * id belongs to the provider (initSession / existingSessionId), so the seam
 * yields the `session` event itself from the provider, not from the stream.
 *
 * The narrow `CoachStreamPart` union below mirrors the subset of AI SDK v6
 * `TextStreamPart` the Coach surface consumes. The seam's SDK loader casts
 * the real fullStream onto it; any part type outside the union (reasoning,
 * start-step, file, source, abort, raw plan/diff/terminal, …) falls to the
 * default arm and is dropped.
 */

/**
 * The ACP provider surfaces every agent tool call through ONE dynamic tool
 * (`acp.acp_provider_agent_dynamic_tool`) whose input JSON carries the real
 * `toolName`. `tool-input-start` parts from the provider already carry the
 * REAL tool name, so a matching `tool-call` is a duplicate notice — skipped.
 */
const ACP_DYNAMIC_TOOL = 'acp.acp_provider_agent_dynamic_tool'

export type CoachStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-start'; toolName: string; title?: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'finish'; finishReason?: unknown }
  | { type: 'error'; error: unknown }

export function deriveCoachEvents(part: CoachStreamPart): CoachEvent[] {
  switch (part.type) {
    // The seam emits the starting/session lifecycle itself before streaming
    // (initSession), so the AI SDK's opening `start` part is not mapped here.
    case 'finish':
      return [{ kind: 'status', state: 'done' }]
    case 'error':
      return [{ kind: 'error', message: part.error instanceof Error ? part.error.message : String(part.error) }]
    case 'text-delta':
      // Skip empty deltas — they carry no text and would spam the event stream.
      return part.text ? [{ kind: 'text', delta: part.text }] : []
    case 'tool-input-start': {
      const event: CoachEvent = { kind: 'tool', tool: part.toolName }
      if (part.title) event.title = part.title
      return [event]
    }
    case 'tool-call':
      // ACP announces each agent tool via tool-input-start (real name); the
      // dynamic-tool tool-call wraps the SAME call, so skip it. Only a
      // non-dynamic tool-call (a future non-ACP provider) is a fresh notice.
      if (part.toolName === ACP_DYNAMIC_TOOL) return []
      return part.toolName ? [{ kind: 'tool', tool: part.toolName }] : []
    default:
      // Reasoning, step boundaries, tool args/ends, raw plan/diff/terminal
      // chunks, … are not part of the CoachEvent surface.
      return []
  }
}
