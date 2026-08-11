import { z } from 'zod'

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
 *  the seam. The workspace must be a real on-disk directory (the seam
 *  re-validates); `sessionId` resumes a previous run's session (ACP
 *  `existingSessionId`, per-app-session only). */
export const coachRunRequestSchema = z.object({
  /** Registry key of the harness to drive (claude, codex, gemini, …). */
  harnessKind: z.string(),
  /** Model id for the run — informational only until ACP model selection
   *  lands (upstream PR #182); the agent runs with its own configured model. */
  model: z.string().optional(),
  /** The user's project repo — must be a real on-disk directory. */
  workspacePath: z.string(),
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

/** `coach:pick-workspace` response — a user-chosen directory via the OS picker.
 *  The dialog IS the authorization; the main process never guesses a path. */
export const coachWorkspaceResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type CoachWorkspaceResult = z.infer<typeof coachWorkspaceResultSchema>

/** One detected harness, as the Coach harness picker sees it (ADR 0016). */
export const coachHarnessRowSchema = z.object({
  /** Canonical tool name — the registry key (claude, gemini, …). */
  kind: z.string(),
  /** Human-readable label shown in the picker. */
  displayName: z.string(),
  /** Informational model list (metadata only — no selection until PR #182). */
  models: z.array(z.string()),
  authStatus: z.enum(['configured', 'unknown']),
})
export type CoachHarnessRow = z.infer<typeof coachHarnessRowSchema>

/** `coach:harnesses` response — the detected harnesses for the picker. */
export const coachHarnessesResultSchema = z.array(coachHarnessRowSchema)
export type CoachHarnessesResult = z.infer<typeof coachHarnessesResultSchema>

