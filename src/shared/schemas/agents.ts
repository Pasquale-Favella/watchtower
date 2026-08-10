import { z } from 'zod'

/**
 * The agent harness event stream — the wire contract between the main-process
 * HarnessRuntime seam and the renderer (ADR 0005). AG-UI chunks emitted by a
 * local coding-agent harness (Claude Code, OpenCode, Codex, …) are derived into
 * this typed union before they cross the IPC boundary; the renderer never sees
 * the raw AG-UI shape. The discriminated union matches the shape settled in the
 * pathfinder prototype (tickets 14/15) and the architecture decision (ticket
 * 18): text deltas, tool-call notices, session ids (for multi-turn resume via
 * the harness's session-id custom event), lifecycle status, and errors.
 */
export const coachEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    state: z.enum(['starting', 'running', 'done']),
  }),
  z.object({
    kind: z.literal('text'),
    /** Assistant text delta — appended to the running message. */
    delta: z.string(),
  }),
  z.object({
    kind: z.literal('tool'),
    /** Tool-call notice: the tool name (e.g. Bash, Read, Edit). */
    tool: z.string(),
    /** Optional human-readable title the harness attached to the call. */
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('session'),
    /** Harness session id (claude-code.session-id / opencode.session-id /
     *  codex.session-id) — the resume handle for follow-up turns. */
    sessionId: z.string(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
  }),
])
export type CoachEvent = z.infer<typeof coachEventSchema>
