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
 * the real fullStream onto it; any part type outside the union (start-step,
 * file, source, abort, raw plan/diff/terminal, …) falls to the default arm
 * and is dropped.
 *
 * Richer turn detail (thinking + tool lifecycle): `reasoning-delta` parts
 * stream the model's thinking, which rides a `reasoning` event so the thread
 * can show a live Thinking block (elements.ai-sdk.dev Reasoning-style).
 * Tool parts now carry the call's lifecycle — `tool-input-start`/`tool-call`
 * open a `started` notice, `tool-result` closes it as `completed` (or
 * `error` when the result is marked failed) — plus truncated JSON previews of
 * the input args and the result output, so the thread can render a
 * Tool-card-style activity panel without shipping raw payloads over IPC.
 */

/**
 * The ACP provider surfaces every agent tool call through ONE dynamic tool
 * (`acp.acp_provider_agent_dynamic_tool`) whose input JSON carries the real
 * `toolName` and `args`. `tool-input-start` parts from the provider already
 * carry the REAL tool name, so a matching `tool-call` is a duplicate notice
 * — but it is ALSO the only part carrying the call's args, so instead of
 * dropping it we re-derive the same `started` notice enriched with the input
 * preview (the renderer merges by id).
 */
const ACP_DYNAMIC_TOOL = 'acp.acp_provider_agent_dynamic_tool'

/** The ACP dynamic tool's input payload — `{ toolCallId, toolName, args }`. */
function parseAcpCall(input: unknown): { toolCallId?: string; toolName?: string; args?: unknown } | null {
  if (typeof input !== 'string') return null
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    if (parsed && typeof parsed.toolName === 'string') {
      return {
        toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
        toolName: parsed.toolName,
        args: parsed.args,
      }
    }
  } catch {
    // Not ACP JSON — leave the null for the caller's non-ACP fallback.
  }
  return null
}

/** Truncated JSON preview of a tool input/output value (keeps IPC small).
 *  Defensive: a non-serializable value (circular ref) becomes no preview — a
 *  throw here would abort the run's stream, which is never worth it for a
 *  cosmetic preview. */
function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      return undefined
    }
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

export type CoachStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; id?: string; delta?: string; text?: string }
  | { type: 'tool-input-start'; id?: string; toolName: string; title?: string }
  | { type: 'tool-call'; toolCallId?: string; toolName: string; input?: unknown; title?: string }
  | { type: 'tool-result'; toolCallId?: string; toolName: string; input?: unknown; output?: unknown; result?: unknown; isError?: boolean; title?: string }
  | { type: 'tool-error'; toolCallId?: string; toolName: string; input?: unknown; error?: unknown }
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
    case 'reasoning-delta': {
      // AI SDK v6 yields reasoning deltas as `delta` on the raw stream and
      // `text` on the fullStream — accept either, and skip empty chunks.
      const delta = part.delta ?? part.text ?? ''
      return delta ? [{ kind: 'reasoning', delta }] : []
    }
    case 'tool-input-start': {
      // ACP announces each agent tool via tool-input-start with the REAL
      // name; the dynamic-tool tool-call below re-announces the same call
      // with its args. Open a `started` notice here.
      const event: CoachEvent = { kind: 'tool', tool: part.toolName, state: 'started' }
      if (part.id) event.id = part.id
      if (part.title) event.title = part.title
      return [event]
    }
    case 'tool-call': {
      // ACP dynamic tool: the call's real name + args ride the input JSON.
      // Re-derive a `started` notice enriched with the args preview — the
      // renderer merges it into the id-matched notice opened above. A
      // NON-ACP tool-call (a future non-ACP provider) is a fresh notice.
      if (part.toolName === ACP_DYNAMIC_TOOL) {
        const real = parseAcpCall(part.input)
        if (!real?.toolName) return []
        const event: CoachEvent = { kind: 'tool', tool: real.toolName, state: 'started' }
        if (real.toolCallId) event.id = real.toolCallId
        const input = preview(real.args)
        if (input) event.input = input
        if (part.title) event.title = part.title
        return [event]
      }
      if (!part.toolName) return []
      const event: CoachEvent = { kind: 'tool', tool: part.toolName, state: 'started' }
      if (part.toolCallId) event.id = part.toolCallId
      const input = preview(part.input)
      if (input) event.input = input
      if (part.title) event.title = part.title
      return [event]
    }
    case 'tool-result': {
      // Close the id-matched started notice as completed (or error when the
      // harness marked the call failed), carrying an output preview. For the
      // ACP dynamic tool the real name rides the input JSON; static tools
      // carry it directly.
      const real = part.toolName === ACP_DYNAMIC_TOOL ? parseAcpCall(part.input) : null
      const tool = real?.toolName ?? part.toolName
      if (!tool) return []
      const event: CoachEvent = { kind: 'tool', tool, state: part.isError ? 'error' : 'completed' }
      if (real?.toolCallId ?? part.toolCallId) event.id = real?.toolCallId ?? part.toolCallId
      // A failed call ships no output preview — the error state is the signal.
      const output = part.isError ? undefined : preview(part.output ?? part.result)
      if (output) event.output = output
      return [event]
    }
    case 'tool-error': {
      const real = part.toolName === ACP_DYNAMIC_TOOL ? parseAcpCall(part.input) : null
      const tool = real?.toolName ?? part.toolName
      if (!tool) return []
      const event: CoachEvent = { kind: 'tool', tool, state: 'error' }
      if (real?.toolCallId ?? part.toolCallId) event.id = real?.toolCallId ?? part.toolCallId
      // Ship a short error message so the card can say WHY the call failed.
      const message = part.error instanceof Error ? part.error.message : String(part.error)
      const error = preview(message)
      if (error) event.error = error
      return [event]
    }
    default:
      // Step boundaries, raw plan/diff/terminal chunks, … are not part of the
      // CoachEvent surface.
      return []
  }
}
