import { platformSpawnCommand as acpSpawnCommand } from '@/infrastructure/process/executable.js'
export { platformSpawnCommand as acpSpawnCommand } from '@/infrastructure/process/executable.js'

import { existsSync, statSync } from 'node:fs'

import type { ACPProvider, ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import type { CoachEvent, CoachSessionModels, CoachSessionModes } from '@/shared/schemas/agents.js'
import {
  CoachSdkFailure,
  coachSdkFailureMessage,
  type CoachSdkFailureStage,
} from '@/infrastructure/agent-harnesses/coach-errors.js'
import type { HarnessInfo } from '@/infrastructure/agent-harnesses/detect.js'
import { type CoachStreamPart, createCoachEventNormalizer } from '@/infrastructure/agent-harnesses/events.js'
import { HARNESS_HANDSHAKE_TIMEOUT_MS } from '@/infrastructure/agent-harnesses/harness-timeouts.js'
import { harnessSpecs } from '@/infrastructure/agent-harnesses/harnesses/index.js'
import type { AcpAdapter, AcpMcpServer, HarnessSpec } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import {
  describeCatalog,
  executeSelectionPlan,
  type HarnessCatalog,
  planModelSelection,
  planModeSelection,
  routingPolicyFor,
  type SelectionProvider,
  SelectionUnavailableError,
} from '@/infrastructure/agent-harnesses/model-routing.js'
import { killProcessTreeSync } from '@/infrastructure/agent-harnesses/process-tree.js'
import { encodeResumeCursor } from '@/infrastructure/agent-harnesses/resume-cursor.js'

/**
 * The HarnessRuntime seam (ticket 18/20): the single main-process module that
 * owns the AI SDK + ACP provider — spawning ACP agents (Claude Code, Codex,
 * OpenCode, Gemini, …) as child processes and streaming their output — and
 * derives the typed CoachEvent stream the renderer consumes. The renderer
 * never touches the SDK. The SDK surface is injected (ADR 0006 isolation), so
 * the seam is testable with a fake SDK; `loadHarnessSdk()` wires the real
 * packages lazily.
 *
 * SDK stack (ADR 0016, revised): the AI SDK (`ai` v6) drives agents over the
 * Agent Client Protocol via `@mcpc-tech/acp-ai-provider`. Each harness spec's
 * `adapter.acpConfig` is the STATIC slice of the real `ACPProviderSettings`;
 * the seam adds the per-run `session.cwd` (the real workspace), the scrubbed
 * env (ADR 0012 — the agent falls back to its own stored login), and the
 * resume handle (`existingSessionId`). There is no sandbox middleware: ACP
 * agents run locally against the workspace.
 *
 * One harness = ONE agent = ONE language model (map 47 tickets 49/51): the
 * seam types against the REAL `ACPProviderSettings`/`ACPProvider` exports —
 * no hand-rolled narrow slices, no `as unknown as` at the provider boundary.
 * Model/mode selection is PROGRESSIVE (ticket 50): `initSession()` may report
 * `models`/`modes` (experimental ACP handshake fields); the seam rides them
 * on the `session` CoachEvent, and passes the renderer's choices (only ever
 * picked from that reported set) to `languageModel(modelId, modeId)`.
 *
 * Packaging constraint (ticket 15): the workspace source must be a REAL
 * on-disk path, never a virtual asar path (child processes cannot read asar).
 * `run` validates this before the SDK is touched.
 */

/** The `createACPProvider` settings — the REAL type, not a local slice. */
export type AcpProviderConfig = ACPProviderSettings

type AcpSelectionProvider = {
  setConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown>
  setModel?: (modelId: string) => Promise<unknown>
  setMode?: (modeId: string) => Promise<unknown>
}

/** The provider surface the seam uses — a structural Pick of the real class,
 *  plus the optional session-config setter the seam adds in loadHarnessSdk
 *  (the real ACPProvider has setModel/setMode for the legacy handshake
 *  fields; configOptions-based agents like claude-agent-acp and opencode need
 *  `session/set_config_option` instead — see model-routing.ts). setModel/setMode
 *  are optional so fakes may omit them;
 *  the real provider always exposes them. */
export type AcpProvider = Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'> &
  AcpSelectionProvider & { forceCleanup?: () => void }

/** The SDK surface the seam depends on — a narrow slice of `ai` +
 *  `@mcpc-tech/acp-ai-provider`. Injected so tests use a fake. */
export interface HarnessSdk {
  createACPProvider(config: AcpProviderConfig): AcpProvider
  streamText(options: {
    model: unknown
    prompt: string
    tools?: unknown
    abortSignal?: AbortSignal
  }): AsyncIterable<CoachStreamPart>
}

/** The slice of a run input needed to SPAWN a provider — shared by `run` and
 *  the `inspect` probe (map 47 ticket 50) so both build the agent exactly the
 *  same way. */
export interface HarnessProviderInput {
  harness: HarnessInfo
  /** The user's project repo — must be a real on-disk directory. */
  workspacePath: string
  /** Resume handle from a previous run's session event. */
  sessionId?: string
  /** Opt-in API-key passthrough: when true the harness's API-key env vars
   *  (e.g. ANTHROPIC_API_KEY) are NOT scrubbed before spawn, so the agent
   *  authenticates the same way the user's terminal does. Default
   *  (absent/false) keeps the ADR 0012 stored-login behaviour. The key itself
   *  is never passed explicitly — it is simply left in the inherited env. */
  allowApiKeyEnv?: boolean
  /** Extra MCP servers to attach to the agent session (the injected in-app
   *  ledger server — map 53). Merged AFTER the spec's own servers. */
  mcpServers?: AcpMcpServer[]
}

export interface HarnessSpawn {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  windowsHide: boolean
}

export interface HarnessRunInput extends HarnessProviderInput {
  /** Agent-declared model id (from a previous session event's models).
   *  Optional — the agent runs with its own configured model when absent. */
  modelId?: string
  /** Agent-declared session mode id (from a previous session event's modes). */
  modeId?: string
  prompt: string
  /** Prompt to use when a resume handle cannot be loaded and the run restarts
   *  with a fresh provider session. */
  freshPrompt?: string
}

/** The handshake probe result — from a pre-flight `initSession` with no
 *  prompt streamed. `sessionId` is the warmed session (the runner resumes it
 *  on the conversation's first run so the agent does not cold-start twice);
 *  absent `models`/`modes` mean the agent declared no such set (progressive:
 *  the pickers render only when present). */
export interface HarnessInspectResult {
  models?: CoachSessionModels
  modes?: CoachSessionModes
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncGenerator<CoachEvent>
  /** Starts a run with an independent stop handle. Unlike AsyncGenerator.return,
   *  stop can abort the SDK stream and tear down the provider while next() is
   *  still pending. */
  runControlled?(input: HarnessRunInput): ControlledHarnessRun
  /** Probes a harness's handshake-declared models/modes WITHOUT running a
   *  prompt (map 47 ticket 50): spawns the ACP provider, initSessions, reads
   *  the session response, and tears the provider down. Throws on failure
   *  (unavailable agent, auth wall) — the runner converts that to the
   *  `{ ok: false }` inspect arm, so a failed probe just leaves the pickers
   *  absent instead of blocking the chat. */
  inspect(input: HarnessProviderInput): Promise<HarnessInspectResult>
  /** Inspect with an independently callable teardown handle for reset races. */
  inspectControlled?(input: HarnessProviderInput): ControlledHarnessInspection
}

export interface ControlledHarnessRun {
  events: AsyncGenerator<CoachEvent>
  stop: () => Promise<void>
}

export interface ControlledHarnessInspection {
  result: Promise<HarnessInspectResult>
  stop: () => Promise<void>
}

export interface NativeHarnessRun {
  readonly events: AsyncIterable<CoachEvent>
  readonly stop: Effect.Effect<void>
}

export interface NativeHarnessInspection {
  readonly result: Effect.Effect<HarnessInspectResult, Error>
  readonly stop: Effect.Effect<void>
}

export class CoachHarnessExecution extends Context.Service<
  CoachHarnessExecution,
  {
    startRun(input: HarnessRunInput): Effect.Effect<NativeHarnessRun, Error>
    startInspection(input: HarnessProviderInput): Effect.Effect<NativeHarnessInspection, Error>
  }
>()('watchtower/main/CoachHarnessExecution') {}

interface PendingCoachEvent {
  readonly event: CoachEvent
  readonly acknowledged: Deferred.Deferred<undefined>
}

function coachEventStream(queue: Queue.Dequeue<PendingCoachEvent, unknown>): Stream.Stream<CoachEvent, unknown> {
  let previous: Deferred.Deferred<undefined> | undefined
  return Stream.fromEffectRepeat(
    Effect.gen(function* () {
      if (previous) yield* Deferred.succeed(previous, undefined)
      const pending = yield* Queue.take(queue)
      previous = pending.acknowledged
      return pending.event
    }),
  )
}

function publishCoachEvent(queue: Queue.Enqueue<PendingCoachEvent, unknown>, event: CoachEvent): Effect.Effect<void> {
  return Effect.gen(function* () {
    const acknowledged = yield* Deferred.make<undefined>()
    yield* Queue.offer(queue, { event, acknowledged })
    yield* Deferred.await(acknowledged)
  })
}

/** A workspace is drivable only when it is a real directory on disk — a
 *  non-existent path or a virtual asar path is refused before any spawn. */
export function assertRealWorkspacePath(workspacePath: string): void {
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new Error(`workspace must be a real on-disk directory: ${workspacePath}`)
  }
  const segments = workspacePath.split(/[/\\]/)
  if (segments.some(segment => segment.endsWith('.asar'))) {
    throw new Error(`workspace must be a real on-disk path, never an asar path: ${workspacePath}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Runs one initSession on a provider and derives the session CoachEvent
 *  payload it implies (the resume handle + any handshake-declared
 *  models/modes). Shared by the main warm-up and the stale-resume fallback so
 *  both emit the session event identically. */
function warmSessionEffect(
  provider: AcpProvider,
  instanceId: string,
  stage: 'session-init' | 'inspection' = 'session-init',
): Effect.Effect<{ sessionId?: string; event?: CoachEvent; catalog: HarnessCatalog }, CoachSdkFailure> {
  return Effect.map(
    sdkPromiseEffect(stage, () => provider.initSession()),
    session => {
      const catalog = describeCatalog(session)
      const sessionId = isRecord(session) ? asString(session.sessionId) : undefined
      if (!sessionId) return { catalog }
      const event: CoachEvent = { kind: 'session', resumeCursor: encodeResumeCursor({ instanceId, sessionId }) }
      if (catalog.models) event.models = catalog.models
      if (catalog.modes) event.modes = catalog.modes
      return { sessionId, event, catalog }
    },
  )
}

/** The env handed to the agent process: the host env MINUS the spec's
 *  scrubEnv keys (ADR 0012) — API keys are never passed, so the CLI uses its
 *  own stored login. The ACP provider's `env` is explicit, so an omitted key
 *  is genuinely absent rather than inherited. The `allowApiKeyEnv` opt-in
 *  (Coach "use API keys from environment") skips scrubbing entirely: the
 *  agent then authenticates exactly like the user's terminal does. */
function scrubbedEnv(scrubEnv: readonly string[], allowApiKeyEnv = false): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!allowApiKeyEnv && scrubEnv.includes(key)) continue
    env[key] = value
  }
  return env
}

/** Signatures of a harness-side AUTHENTICATION failure (stored login expired
 *  or missing, e.g. Claude's "OAuth session expired and could not be
 *  refreshed"). Matched case-insensitively against raw agent/provider error
 *  text. Deliberately narrow: a plain "session expired" (an ACP resume-handle
 *  expiry, which has its own retry path) must NOT match. */
const AUTH_FAILURE_PATTERNS = [
  /failed to authenticate/i,
  /oauth session expired/i,
  /authentication_failed/i,
  /authrequired/i,
  /please run \/login/i,
  /not logged in/i,
  /sign-in required/i,
]

/** True when a raw agent/provider error message reports an authentication
 *  wall rather than any other failure. Pure — unit-tested directly. */
export function isAuthFailureMessage(message: string): boolean {
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message))
}

/** Single lookup for the harness spec registry — shared by spawn config and
 *  auth-hint projection so the `kind` match lives in one place. */
function specFor(kind: string): HarnessSpec | undefined {
  return harnessSpecs.find(spec => spec.kind === kind)
}

/** Actionable remedy for an authentication wall, per harness. The ACP
 *  handshake reports models/modes WITHOUT authenticating, so by the time
 *  this fires the picker already looked healthy — the message must say what
 *  to do, not just what broke. */
function authHintForHarness(kind: string, displayName: string): string {
  const loginCommand = specFor(kind)?.auth?.loginCommand?.join(' ')
  const signInHint = loginCommand
    ? `${displayName} sign-in required — run '${loginCommand}' in a terminal, then retry.`
    : `${displayName} sign-in required — sign in with the harness's own CLI, then retry.`
  if (kind === 'claude') {
    return (
      `${signInHint} ` +
      `If you sign in with ANTHROPIC_API_KEY in your terminal instead, turn on ` +
      `'Use API keys from environment' in Coach and retry.`
    )
  }
  return signInHint
}

function failureFromSdk(stage: CoachSdkFailureStage, error: unknown): CoachSdkFailure {
  const rawMessage = error instanceof Error ? error.message : String(error)
  return new CoachSdkFailure({ stage, reason: 'rejected', authentication: isAuthFailureMessage(rawMessage) })
}

function sdkPromiseEffect<T>(
  stage: CoachSdkFailureStage,
  operation: () => Promise<T>,
): Effect.Effect<T, CoachSdkFailure> {
  return Effect.tryPromise({ try: operation, catch: error => failureFromSdk(stage, error) })
}

/** Convert only a synchronous SDK call; surrounding local computations remain
 *  outside this boundary and therefore keep defect semantics. */
function sdkSync<T>(stage: CoachSdkFailureStage, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    throw failureFromSdk(stage, error)
  }
}

function toHarnessError(harness: HarnessInfo, failure: CoachSdkFailure): CoachEvent {
  const message = coachSdkFailureMessage(
    harness.displayName,
    failure,
    authHintForHarness(harness.kind, harness.displayName),
  )
  return { kind: 'error', message }
}

function selectionBoundary(provider: AcpProvider): SelectionProvider {
  return {
    ...(provider.setConfigOption
      ? {
          setConfigOption: (args: { sessionId: string; configId: string; value: string }) =>
            sdkPromiseEffect('selection', () => provider.setConfigOption!(args)),
        }
      : {}),
    ...(provider.setModel
      ? { setModel: (modelId: string) => sdkPromiseEffect('selection', () => provider.setModel!(modelId)) }
      : {}),
    ...(provider.setMode
      ? { setMode: (modeId: string) => sdkPromiseEffect('selection', () => provider.setMode!(modeId)) }
      : {}),
  }
}

export interface HarnessRuntimeOptions {
  /** Platform used for spawn-command wrapping (defaults to process.platform).
   *  Injectable so the win32 shim handling is unit-testable on any host. */
  platform?: NodeJS.Platform
  cancelDrainMs?: number
}

export const CANCEL_DRAIN_MS = 1500

/** Bounded iterator drain for cancellation (the exemplar call-site, now
 *  named): `iterator.return()` may hang on a stalled stream, so bound it
 *  with the Effect Clock and ignore the outcome — late events are already
 *  flushed, the child is reaped by the provider teardown that follows. */
export const drainIteratorEffect = Effect.fn('drainIteratorEffect')(function* (
  onReturn: () => Promise<unknown>,
  cancelDrainMs: number,
) {
  yield* Effect.tryPromise({
    try: () => onReturn(),
    catch: error => error,
  }).pipe(Effect.timeoutOption(Duration.millis(cancelDrainMs)), Effect.ignore)
})

function forceProviderCleanup(provider: AcpProvider): void {
  try {
    provider.forceCleanup?.()
  } catch {
    // Forced teardown is best effort; the owning adapter performs the kill.
  }
}

function boundedProviderCleanup(provider: AcpProvider, timeoutMs: number): Effect.Effect<void> {
  return Effect.suspend(() => {
    let cleanup: void | Promise<void>
    try {
      cleanup = provider.cleanup()
    } catch {
      forceProviderCleanup(provider)
      return Effect.void
    }
    return Effect.tryPromise({
      try: async () => {
        try {
          await cleanup
          return true
        } catch {
          return false
        }
      },
      catch: () => false,
    }).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.map(outcome => {
        if (outcome._tag === 'None' || !outcome.value) forceProviderCleanup(provider)
      }),
      Effect.ignore,
    )
  })
}

/** AbortSignal teardown that never fails — `controller.abort()` is void but
 *  typed as throwable, so isolate the try/catch in one place. Shared by both
 *  arms of the run-scope finalizer below. */
function abortControllerQuietly(controller: AbortController): void {
  try {
    controller.abort()
  } catch {
    // Abort must never fail teardown.
  }
}

function acpConfigFor(kind: string): AcpAdapter['acpConfig'] {
  const spec = specFor(kind)
  if (!spec || spec.adapter.kind !== 'acp') {
    throw new Error(`harness ${kind} has no ACP adapter`)
  }
  return spec.adapter.acpConfig
}

interface HarnessEngine {
  run(input: HarnessRunInput, publish: (event: CoachEvent) => Effect.Effect<unknown>): Effect.Effect<void, unknown>
  inspect(input: HarnessProviderInput): Effect.Effect<HarnessInspectResult, Error>
}

function makeHarnessEngine(sdk: HarnessSdk, options: HarnessRuntimeOptions): HarnessEngine {
  const platform = options.platform ?? process.platform
  const cancelDrainMs = options.cancelDrainMs ?? CANCEL_DRAIN_MS

  function createProvider(input: HarnessProviderInput): AcpProvider {
    assertRealWorkspacePath(input.workspacePath)
    const acp = acpConfigFor(input.harness.kind)
    const spawn = createHarnessSpawn(input.harness, input.workspacePath, platform, input.allowApiKeyEnv)
    return sdkSync('provider-create', () =>
      sdk.createACPProvider({
        command: spawn.command,
        args: spawn.args,
        env: spawn.env,
        session: { cwd: input.workspacePath, mcpServers: [...(acp.mcpServers ?? []), ...(input.mcpServers ?? [])] },
        ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
        ...(acp.sessionDelayMs ? { sessionDelayMs: acp.sessionDelayMs } : {}),
        ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
      }),
    )
  }

  function run(
    input: HarnessRunInput,
    publish: (event: CoachEvent) => Effect.Effect<unknown>,
  ): Effect.Effect<void, unknown> {
    return Effect.scoped(
      Effect.gen(function* () {
        let provider: AcpProvider | undefined
        let providerCleaned = false
        const controller = new AbortController()
        let iterator: AsyncIterator<CoachStreamPart> | undefined
        let endedNormally = false
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!endedNormally) yield* Effect.sync(() => abortControllerQuietly(controller))
            const activeIterator = iterator
            const returnIterator = activeIterator?.return
            if (activeIterator && returnIterator)
              yield* drainIteratorEffect(() => returnIterator.call(activeIterator), cancelDrainMs)
            const activeProvider = provider
            if (activeProvider && !providerCleaned) yield* boundedProviderCleanup(activeProvider, cancelDrainMs)
          }),
        )

        const created = yield* Effect.result(Effect.try({ try: () => createProvider(input), catch: error => error }))
        if (created._tag === 'Failure') {
          if (created.failure instanceof CoachSdkFailure) yield* publish(toHarnessError(input.harness, created.failure))
          else return yield* Effect.fail(created.failure)
          return
        }
        provider = created.success
        yield* publish({ kind: 'status', state: 'starting' })
        const instanceId = input.harness.instanceId ?? input.harness.kind
        let sessionId = input.sessionId
        let catalog: HarnessCatalog = describeCatalog(undefined)
        let restartedFresh = false

        let warmed = yield* Effect.result(warmSessionEffect(provider, instanceId))
        if (warmed._tag === 'Failure' && input.sessionId && warmed.failure instanceof CoachSdkFailure) {
          yield* boundedProviderCleanup(provider, cancelDrainMs)
          providerCleaned = true
          const replacement = yield* Effect.result(
            Effect.try({ try: () => createProvider({ ...input, sessionId: undefined }), catch: error => error }),
          )
          if (replacement._tag === 'Failure') {
            if (replacement.failure instanceof CoachSdkFailure)
              yield* publish(toHarnessError(input.harness, replacement.failure))
            else return yield* Effect.fail(replacement.failure)
            return
          }
          provider = replacement.success
          providerCleaned = false
          warmed = yield* Effect.result(warmSessionEffect(provider, instanceId))
          if (warmed._tag === 'Success') {
            restartedFresh = true
            yield* publish({
              kind: 'notice',
              message: 'The previous session could not be resumed — continuing in a fresh session.',
            })
          }
        }
        if (warmed._tag === 'Failure') {
          if (warmed.failure instanceof CoachSdkFailure) yield* publish(toHarnessError(input.harness, warmed.failure))
          else return yield* Effect.fail(warmed.failure)
          return
        }
        sessionId = warmed.success.sessionId ?? sessionId
        catalog = warmed.success.catalog
        if (warmed.success.event) yield* publish(warmed.success.event)

        let modelId = input.modelId
        const activeProvider = provider
        const activeSessionId = sessionId
        if (!activeProvider) return yield* Effect.fail(new Error('Coach provider was not acquired'))
        if ((input.modelId || input.modeId) && activeSessionId) {
          const selected = yield* Effect.result(
            Effect.gen(function* () {
              const policy = routingPolicyFor(input.harness.kind)
              if (input.modelId)
                modelId = yield* executeSelectionPlan(
                  selectionBoundary(activeProvider),
                  activeSessionId,
                  planModelSelection(policy, catalog, input.modelId),
                )
              if (input.modeId)
                yield* executeSelectionPlan(
                  selectionBoundary(activeProvider),
                  activeSessionId,
                  planModeSelection(policy, catalog, input.modeId),
                )
            }),
          )
          if (selected._tag === 'Failure') {
            if (selected.failure instanceof CoachSdkFailure)
              yield* publish(toHarnessError(input.harness, selected.failure))
            else if (selected.failure instanceof SelectionUnavailableError)
              yield* publish({ kind: 'error', message: selected.failure.message })
            else return yield* Effect.fail(selected.failure)
            return
          }
        }

        yield* Effect.try({
          try: () => {
            const model = sdkSync('stream-create', () => activeProvider.languageModel(modelId, input.modeId))
            const tools = sdkSync('stream-create', () => activeProvider.tools)
            const stream = sdkSync('stream-create', () =>
              sdk.streamText({
                model,
                prompt: restartedFresh ? (input.freshPrompt ?? input.prompt) : input.prompt,
                tools,
                abortSignal: controller.signal,
              }),
            )
            iterator = sdkSync('stream-create', () => stream[Symbol.asyncIterator]())
          },
          catch: error => error,
        })
        const activeIterator = iterator
        if (!activeIterator) return yield* Effect.fail(new Error('Coach stream iterator was not acquired'))
        const normalize = createCoachEventNormalizer()
        for (;;) {
          const next = yield* sdkPromiseEffect('stream-next', () => activeIterator.next())
          if (next.done) {
            endedNormally = true
            return
          }
          for (const event of normalize(next.value as CoachStreamPart)) {
            yield* publish(
              event.kind === 'error'
                ? toHarnessError(input.harness, failureFromSdk('stream-next', event.message))
                : event,
            )
          }
        }
      }),
    )
  }

  function inspect(input: HarnessProviderInput): Effect.Effect<HarnessInspectResult, Error> {
    return Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* Effect.acquireRelease(
          Effect.try({
            try: () => createProvider(input),
            catch: error => (error instanceof Error ? error : new Error(String(error))),
          }),
          provider => boundedProviderCleanup(provider, cancelDrainMs),
        )
        const result = yield* sdkPromiseEffect('inspection', () => provider.initSession()).pipe(
          Effect.map(describeCatalog),
          Effect.timeoutOption(Duration.millis(HARNESS_HANDSHAKE_TIMEOUT_MS)),
        )
        if (result._tag === 'None')
          return yield* Effect.fail(
            new CoachSdkFailure({ stage: 'inspection', reason: 'timeout', authentication: false }),
          )
        return {
          ...(result.value.models ? { models: result.value.models } : {}),
          ...(result.value.modes ? { modes: result.value.modes } : {}),
        }
      }),
    )
  }

  return { run, inspect }
}

export function coachHarnessExecutionLayer(
  options: HarnessRuntimeOptions = {},
  loadSdk: () => Promise<HarnessSdk> = loadHarnessSdk,
): Layer.Layer<CoachHarnessExecution> {
  return Layer.effect(
    CoachHarnessExecution,
    Effect.gen(function* () {
      const fibers = yield* FiberSet.make<unknown, unknown>()
      let enginePromise: Promise<HarnessEngine> | undefined
      const engine = Effect.tryPromise({
        try: () => (enginePromise ??= loadSdk().then(sdk => makeHarnessEngine(sdk, options))),
        catch: error =>
          error instanceof CoachSdkFailure
            ? error
            : new CoachSdkFailure({ stage: 'sdk-load', reason: 'rejected', authentication: false }),
      })
      function startRun(input: HarnessRunInput): Effect.Effect<NativeHarnessRun, Error> {
        return Effect.gen(function* () {
          assertRealWorkspacePath(input.workspacePath)
          const queue = yield* Queue.unbounded<PendingCoachEvent, unknown>()
          const runtime = yield* Stream.toAsyncIterableEffect(coachEventStream(queue))
          const fiber = yield* FiberSet.run(
            fibers,
            Effect.flatMap(engine, harnessEngine =>
              harnessEngine.run(input, event => publishCoachEvent(queue, event)),
            ).pipe(
              Effect.tapCause(cause => Queue.failCause(queue, cause)),
              Effect.ensuring(Queue.end(queue)),
            ),
          )
          return {
            events: runtime,
            stop: Fiber.interrupt(fiber).pipe(Effect.asVoid),
          }
        })
      }
      function startInspection(input: HarnessProviderInput): Effect.Effect<NativeHarnessInspection, Error> {
        return Effect.gen(function* () {
          assertRealWorkspacePath(input.workspacePath)
          const fiber = yield* FiberSet.run(
            fibers,
            Effect.flatMap(engine, harnessEngine => harnessEngine.inspect(input)),
          )
          return { result: Fiber.join(fiber), stop: Fiber.interrupt(fiber).pipe(Effect.asVoid) }
        })
      }
      return CoachHarnessExecution.of({ startRun, startInspection })
    }),
  )
}

/** Builds the exact scrubbed ACP process descriptor shared by runs and probes.
 *  A BUNDLED ACP server runs through the app's own Node (`process.execPath` +
 *  ELECTRON_RUN_AS_NODE, the ledger-mcp pattern); PATH-resolved harnesses
 *  spawn the spec command through the win32 shim handling. */
export function createHarnessSpawn(
  harness: HarnessInfo,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  allowApiKeyEnv = false,
): HarnessSpawn {
  const acp = acpConfigFor(harness.kind)
  const spawn = harness.bundledEntry
    ? { command: process.execPath, args: [harness.bundledEntry, ...(acp.args ?? [])] }
    : acpSpawnCommand(acp.command, acp.args ?? [], platform)
  const env = scrubbedEnv(harness.scrubEnv, allowApiKeyEnv)
  // Inert under real Node, so tests are unaffected.
  if (harness.bundledEntry) env.ELECTRON_RUN_AS_NODE = '1'
  return { command: spawn.command, args: spawn.args, env, cwd, windowsHide: true }
}

/** Compatibility facade for the existing direct runtime tests and non-IPC callers.
 * Remove once those callers exercise CoachHarnessExecution through MainRuntime. */
export function createHarnessRuntime(sdk: HarnessSdk, options: HarnessRuntimeOptions = {}): HarnessRuntime {
  const engine = makeHarnessEngine(sdk, options)

  function startRun(input: HarnessRunInput): ControlledHarnessRun {
    assertRealWorkspacePath(input.workspacePath)
    const queue = Effect.runSync(Queue.unbounded<PendingCoachEvent, unknown>())
    const fiber = Effect.runFork(
      engine
        .run(input, event => publishCoachEvent(queue, event))
        .pipe(
          Effect.tapCause(cause => Queue.failCause(queue, cause)),
          Effect.ensuring(Queue.end(queue)),
        ),
    )
    const stream = Effect.runSync(Stream.toAsyncIterableEffect(coachEventStream(queue)))
    let stopPromise: Promise<void> | undefined
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise
      stopPromise = Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined)
      return stopPromise
    }
    const events = (async function* (): AsyncGenerator<CoachEvent> {
      let completed = false
      try {
        for await (const event of stream) yield event
        completed = true
      } finally {
        if (!completed) await stop()
      }
    })()
    return { events, stop }
  }

  function startInspection(input: HarnessProviderInput): ControlledHarnessInspection {
    let stopped = false
    const fiber = Effect.runFork(engine.inspect(input))
    return {
      result: Effect.runPromise(Fiber.join(fiber)).catch(error => {
        if (stopped) throw new CoachSdkFailure({ stage: 'inspection', reason: 'cancelled', authentication: false })
        throw error
      }),
      stop: async () => {
        stopped = true
        await Effect.runPromise(Fiber.interrupt(fiber))
      },
    }
  }

  return {
    run(input): AsyncGenerator<CoachEvent> {
      return startRun(input).events
    },
    runControlled: startRun,
    inspectControlled: startInspection,
    inspect(input): Promise<HarnessInspectResult> {
      return startInspection(input).result
    },
  }
}
/** The slice of the provider's private `ACPLanguageModel` the win32 hook touches. */
interface ProviderModelInternals {
  agentProcess?: { pid?: number } | null
  forceCleanup?: () => void
}

/** win32: the provider's `forceCleanup` kills only the `cmd.exe` shim wrapper,
 *  orphaning the real agent — kill the whole tree first, synchronously, so the
 *  root is still alive when taskkill walks it. */
export function killTreeBeforeForceCleanup(
  model: ProviderModelInternals,
  killTree: (pid: number) => void = killProcessTreeSync,
): void {
  const original = model.forceCleanup
  if (!original) return
  model.forceCleanup = () => {
    const pid = model.agentProcess?.pid
    if (pid !== undefined) killTree(pid)
    original.call(model)
  }
}

/** Wire the REAL AI SDK + ACP provider lazily (ESM packages, dynamic import
 *  so the seam's import surface stays light and the app boots without them).
 *  The seam has zero per-harness adapter-wiring code (ADR 0016): every spec
 *  carries its own ACP descriptor, and `createHarnessRuntime` reads it. The
 *  created provider is augmented with `setConfigOption` (a thin delegate to
 *  the underlying ACP connection's `setSessionConfigOption`) so runs can apply
 *  model/mode picks for configOptions-based agents — the upstream provider
 *  class only exposes the legacy setModel/setMode pair. */
export async function loadHarnessSdk(): Promise<HarnessSdk> {
  const [{ streamText }, { createACPProvider }] = await Promise.all([
    import('ai'),
    import('@mcpc-tech/acp-ai-provider'),
  ]).catch(() => {
    throw new CoachSdkFailure({ stage: 'sdk-load', reason: 'rejected', authentication: false })
  })
  return {
    // The real factory's signature IS `(config: ACPProviderSettings) =>
    // ACPProvider` — the seam's `AcpProviderConfig`/`AcpProvider` are that
    // real type (map 47 ticket 51), so no cast is needed at this boundary
    // except for the additive setConfigOption augmentation below.
    createACPProvider: ((config: AcpProviderConfig): AcpProvider => {
      const provider = createACPProvider(config) as unknown as AcpProvider & {
        model?: ProviderModelInternals & {
          connection?: {
            setSessionConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown>
          }
        }
      }
      if (process.platform === 'win32') {
        // The model is created lazily by initSession anyway; create it now to hook its teardown.
        provider.languageModel()
        if (provider.model) killTreeBeforeForceCleanup(provider.model)
      }
      provider.forceCleanup = () => provider.model?.forceCleanup?.()
      provider.setConfigOption = async (args: { sessionId: string; configId: string; value: string }) => {
        const connection = provider.model?.connection
        if (!connection?.setSessionConfigOption) {
          throw new Error('agent does not support session config options')
        }
        return connection.setSessionConfigOption(args)
      }
      return provider
    }) as HarnessSdk['createACPProvider'],
    streamText: (options: { model: unknown; prompt: string; tools?: unknown; abortSignal?: AbortSignal }) =>
      streamText(options as unknown as Parameters<typeof streamText>[0])
        .fullStream as unknown as AsyncIterable<CoachStreamPart>,
  }
}
