import { z } from 'zod'

import { overviewScopeSchema } from './overview.js'
import { skillsProseRequestSchema } from './skills.js'

/**
 * The agent harness event stream — the wire contract between the main-process
 * HarnessRuntime seam and the renderer (ADR 0005). Stream parts from the AI SDK
 * + ACP provider (a local coding-agent harness: Claude Code, OpenCode, Codex,
 * …) are derived into this typed union before they cross the IPC boundary; the
 * renderer never sees the raw stream shape. The discriminated union matches the
 * shape settled in the pathfinder prototype (tickets 14/15) and the
 * architecture decision (ticket 18): text deltas, tool-call notices, session
 * ids (the ACP session resume handle), lifecycle status, and errors.
 *
 * Model/mode session-meta (map 47 ticket 50): the ACP handshake
 * (`initSession()`) can report the agent's selectable models and modes. Those
 * ride the `session` event as optional `models`/`modes` — the renderer shows a
 * picker ONLY when they are present (progressive: the agent itself declares
 * what is selectable).
 */

/** One selectable ACP model (ACP `ModelInfo` subset — description optional). */
export const coachModelInfoSchema = z.object({
  modelId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
})
export type CoachModelInfo = z.infer<typeof coachModelInfoSchema>

/** One selectable ACP session mode (e.g. ask / plan / acceptEdits). */
export const coachSessionModeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
})
export type CoachSessionMode = z.infer<typeof coachSessionModeSchema>

/** The agent's selectable models + the one currently active. */
export const coachSessionModelsSchema = z.object({
  availableModels: z.array(coachModelInfoSchema),
  currentModelId: z.string(),
})
export type CoachSessionModels = z.infer<typeof coachSessionModelsSchema>

/** The agent's selectable modes + the one currently active. */
export const coachSessionModesSchema = z.object({
  availableModes: z.array(coachSessionModeSchema),
  currentModeId: z.string(),
})
export type CoachSessionModes = z.infer<typeof coachSessionModesSchema>

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
    /** Progressive model/mode selection (map 47 ticket 50): present ONLY when
     *  the agent's handshake reported selectable options. */
    models: coachSessionModelsSchema.optional(),
    modes: coachSessionModesSchema.optional(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
  }),
])
export type CoachEvent = z.infer<typeof coachEventSchema>

/** The `coach:event` push envelope — one CoachEvent tagged with the run it
 *  belongs to, so the renderer routes concurrent/sequential run streams
 *  without mixing deltas. */
export const coachEventEnvelopeSchema = z.object({
  runId: z.string(),
  event: coachEventSchema,
})
export type CoachEventEnvelope = z.infer<typeof coachEventEnvelopeSchema>

/** The mode tag of a Coach & Skills run (ADR 0017): `coach` runs a
 *  free-form prompt; `build-skill` turns a detected candidate into a SKILL.md
 *  draft (the prompt is built main-side from the candidate's NORMALIZED
 *  evidence — the renderer never sends raw transcripts). */
export const coachModeSchema = z.enum(['coach', 'build-skill'])
export type CoachMode = z.infer<typeof coachModeSchema>

/** `coach:run` request — the renderer's ask to drive one harness run through
 *  the seam. There is NO workspace picker (map 53): the main process runs
 *  each conversation in a private temp directory it owns and cleans up;
 *  `sessionId` resumes a previous run's session (ACP `existingSessionId`, and
 *  with it the conversation's temp workspace).
 *
 * The harness reads the platform's own data through the in-app ledger MCP
 * server, scoped to `scope` — the conversation's snapshot of the current UI
 * scope (period/provider/range), baked at spawn.
 *
 * Model/mode selection is PROGRESSIVE (map 47 ticket 50): the renderer may
 * only send `modelId`/`modeId` that the agent's own handshake reported via the
 * `session` event's models/modes — there is no arbitrary model picker. */
export const coachRunRequestSchema = z.object({
  /** Registry key of the harness to drive (claude, codex, gemini, …). */
  harnessKind: z.string(),
  /** Agent-declared model id (from the session event's models), optional. */
  modelId: z.string().optional(),
  /** Agent-declared session mode id (from the session event's modes). */
  modeId: z.string().optional(),
  /** The conversation's UI-scope snapshot — the data window the in-app ledger
   *  MCP server exposes (map 53). Absent = the widest scope ('all'). */
  scope: overviewScopeSchema.optional(),
  /** Mode tag (ADR 0017): `coach` (default) runs `prompt`; `build-skill`
   *  requires `evidence` and the main process builds the authoring prompt. */
  mode: coachModeSchema.default('coach'),
  /** The free-form prompt for a `coach` run (ignored when mode is
   *  build-skill — the prompt is derived from the evidence). */
  prompt: z.string().optional(),
  /** The detected candidate for a `build-skill` run (required then): NORMALIZED
   *  evidence only — never raw transcripts or session text. */
  evidence: skillsProseRequestSchema.optional(),
  /** Resume handle from a previous run's session event. */
  sessionId: z.string().optional(),
})
export type CoachRunRequest = z.infer<typeof coachRunRequestSchema>

/** `coach:run` response — an immediate ack with the run id; the events land
 *  on the `coach:event` push channel as they stream. */
export const coachRunResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), runId: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type CoachRunResult = z.infer<typeof coachRunResultSchema>

/** One detected harness, as the Coach harness picker sees it (ADR 0016,
 *  reshaped by map 47 ticket 49). A harness is ONE agent = ONE language model:
 *  no static model list rides the row — selectable models/modes arrive only
 *  via the live handshake (`session` event models/modes, ticket 50). */
export const coachHarnessRowSchema = z.object({
  /** Canonical tool name — the registry key (claude, gemini, …). */
  kind: z.string(),
  /** Human-readable label shown in the picker. */
  displayName: z.string(),
  authStatus: z.enum(['configured', 'unknown']),
})
export type CoachHarnessRow = z.infer<typeof coachHarnessRowSchema>

/** `coach:harnesses` response — the detected harnesses for the picker. */
export const coachHarnessesResultSchema = z.array(coachHarnessRowSchema)
export type CoachHarnessesResult = z.infer<typeof coachHarnessesResultSchema>

