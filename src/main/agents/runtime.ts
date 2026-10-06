import { existsSync, statSync } from 'node:fs'

import type { ACPProvider, ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'

import type { CoachEvent, CoachSessionModels, CoachSessionModes } from '../../shared/schemas/agents.js'
import { CoachSdkFailure, coachSdkFailureMessage, type CoachSdkFailureStage } from './coach-errors.js'
import type { HarnessInfo } from './detect.js'
import { type CoachStreamPart, createCoachEventNormalizer } from './events.js'
import { HARNESS_HANDSHAKE_TIMEOUT_MS } from './harness-timeouts.js'
import { harnessSpecs } from './harnesses/index.js'
import type { AcpAdapter, AcpMcpServer, HarnessSpec } from './harnesses/types.js'
import {
  describeCatalog,
  executeSelectionPlan,
  type HarnessCatalog,
  planModelSelection,
  planModeSelection,
  routingPolicyFor,
  type SelectionProvider,
  SelectionUnavailableError,
} from './model-routing.js'
import { killProcessTreeSync } from './process-tree.js'
import { encodeResumeCursor } from './resume-cursor.js'

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

/** The provider surface the seam uses — a structural Pick of the real class,
 *  plus the optional session-config setter the seam adds in loadHarnessSdk
 *  (the real ACPProvider has setModel/setMode for the legacy handshake
 *  fields; configOptions-based agents like claude-agent-acp and opencode need
 *  `session/set_config_option` instead — see model-routing.ts). setModel/setMode
 *  are optional so fakes may omit them;
 *  the real provider always exposes them. */
export type AcpProvider = Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'> &
  SelectionProvider & { forceCleanup?: () => void }

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

interface OwnedHarnessRun extends ControlledHarnessRun {
  legacyEvents: AsyncGenerator<CoachEvent>
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
async function warmSession(
  provider: AcpProvider,
  instanceId: string,
  stage: 'session-init' | 'inspection' = 'session-init',
): Promise<{ sessionId?: string; event?: CoachEvent; catalog: HarnessCatalog }> {
  const session = (await sdkPromise(stage, () => provider.initSession())) as unknown
  const catalog = describeCatalog(session)
  const sessionId = isRecord(session) ? asString(session.sessionId) : undefined
  if (!sessionId) return { catalog }
  const event: CoachEvent = { kind: 'session', resumeCursor: encodeResumeCursor({ instanceId, sessionId }) }
  if (catalog.models) event.models = catalog.models
  if (catalog.modes) event.modes = catalog.modes
  return { sessionId, event, catalog }
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

/** Actionable remedy for an authentication wall, per harness. The ACP
 *  handshake reports models/modes WITHOUT authenticating, so by the time
 *  this fires the picker already looked healthy — the message must say what
 *  to do, not just what broke. */
/** Single lookup for the harness spec registry — shared by spawn config and
 *  auth-hint projection so the `kind` match lives in one place. */
function specFor(kind: string): HarnessSpec | undefined {
  return harnessSpecs.find(spec => spec.kind === kind)
}

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

/** Convert only a call that directly enters an SDK promise API. */
async function sdkPromise<T>(stage: CoachSdkFailureStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw failureFromSdk(stage, error)
  }
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
            sdkPromise('selection', () => provider.setConfigOption!(args)),
        }
      : {}),
    ...(provider.setModel
      ? { setModel: (modelId: string) => sdkPromise('selection', () => provider.setModel!(modelId)) }
      : {}),
    ...(provider.setMode
      ? { setMode: (modeId: string) => sdkPromise('selection', () => provider.setMode!(modeId)) }
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

function boundedProviderCleanup(provider: AcpProvider, timeoutMs: number): Promise<void> {
  let cleanup: void | Promise<void>
  try {
    cleanup = provider.cleanup()
  } catch {
    forceProviderCleanup(provider)
    return Promise.resolve()
  }
  return Effect.runPromise(
    Effect.tryPromise({
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
    ),
  )
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

/** npm-global CLIs on Windows are `.cmd` shims (with a POSIX-script alias)
 *  that Node's shell-less `spawn` cannot execute — spawning the bare name
 *  fails with ENOENT and an unhandled child-process error. Routing the
 *  command through `cmd.exe /c` lets the shim resolve (verified end-to-end
 *  against `opencode acp`); native `.exe` binaries spawn directly. Other
 *  platforms pass through unchanged.
 *
 *  NOTE: `cmd.exe /c` interprets the rest of the line, so args containing
 *  spaces or cmd metacharacters (`& | ^ % <>`) would be mis-parsed. All
 *  current spec args are single tokens — keep future spec args token-only. */
export function acpSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
    return { command, args: [...args] }
  }
  return { command: 'cmd.exe', args: ['/c', command, ...args] }
}

function acpConfigFor(kind: string): AcpAdapter['acpConfig'] {
  const spec = specFor(kind)
  if (!spec || spec.adapter.kind !== 'acp') {
    throw new Error(`harness ${kind} has no ACP adapter`)
  }
  return spec.adapter.acpConfig
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

export function createHarnessRuntime(sdk: HarnessSdk, options: HarnessRuntimeOptions = {}): HarnessRuntime {
  const platform = options.platform ?? process.platform
  const cancelDrainMs = options.cancelDrainMs ?? CANCEL_DRAIN_MS

  /** Builds the ACP provider for a harness run — the ONE place the seam maps
   *  a HarnessInfo + workspace + resume handle onto `createACPProvider`
   *  (ADR 0016), shared by `run` and the `inspect` probe so both spawn the
   *  agent exactly the same way. Validates the workspace first: a bad path
   *  must fail loudly and cheaply, never as an inscrutable spawn error
   *  (ticket 15 constraint). */
  function createProvider(input: HarnessProviderInput): AcpProvider {
    assertRealWorkspacePath(input.workspacePath)

    const acp = acpConfigFor(input.harness.kind)
    const spawn = createHarnessSpawn(input.harness, input.workspacePath, platform, input.allowApiKeyEnv)

    return sdkSync('provider-create', () =>
      sdk.createACPProvider({
        command: spawn.command,
        args: spawn.args,
        env: spawn.env,
        session: {
          cwd: input.workspacePath,
          mcpServers: [...(acp.mcpServers ?? []), ...(input.mcpServers ?? [])],
        },
        ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
        ...(acp.sessionDelayMs ? { sessionDelayMs: acp.sessionDelayMs } : {}),
        ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
      }),
    )
  }

  function createControlledRun(input: HarnessRunInput): OwnedHarnessRun {
    let stopped = false
    const stopWaiters = new Set<() => void>()
    let activeProvider: AcpProvider | undefined
    let activeController: AbortController | undefined
    let streamIterator: (AsyncIterator<CoachStreamPart> & { return?: () => Promise<unknown> }) | undefined
    let stopPromise: Promise<void> | undefined
    let drainPromise: Promise<void> | undefined
    let providerCleanup: Promise<void> | undefined

    const cleanupCurrentProvider = (): Promise<void> => {
      const current = activeProvider
      if (!current) return Promise.resolve()
      if (providerCleanup) return providerCleanup
      // Invoke cleanup synchronously so cancellation reaches the ACP provider
      // before waiting on a pending SDK pull. The provider's cleanup is the
      // process owner and force-kills its child tree on Windows.
      providerCleanup = boundedProviderCleanup(current, cancelDrainMs)
      return providerCleanup
    }

    const drainStream = (): Promise<void> => {
      if (drainPromise) return drainPromise
      const iterator = streamIterator
      if (!iterator || typeof iterator.return !== 'function') return Promise.resolve()
      const onReturn = iterator.return.bind(iterator)
      drainPromise = Effect.runPromise(drainIteratorEffect(() => onReturn(), cancelDrainMs))
      return drainPromise
    }

    const source = (async function* (): AsyncGenerator<CoachEvent> {
      let provider: AcpProvider
      try {
        provider = createProvider(input)
      } catch (error) {
        if (!(error instanceof CoachSdkFailure)) throw error
        yield toHarnessError(input.harness, error)
        return
      }
      activeProvider = provider
      if (stopped) {
        await cleanupCurrentProvider()
        return
      }
      const instanceId = input.harness.instanceId ?? input.harness.kind

      try {
        yield { kind: 'status', state: 'starting' }
        // Warm the ACP session up front (cuts time-to-first-token) and grab
        // the resume handle. An unavailable agent (binary missing, auth wall)
        // surfaces here as a cheap error event — never an inscrutable spawn
        // crash mid-stream. The handshake may ALSO report selectable
        // models/modes — legacy `models`/`modes` or the canonical
        // `configOptions` selects (opencode and claude-agent-acp advertise
        // models only there) — those ride the session event so the renderer
        // can show a progressive picker (ticket 50).
        let sessionId: string | undefined = input.sessionId
        let warmCatalog: HarnessCatalog | undefined
        let restartedFresh = false
        try {
          const warm = await warmSession(provider, instanceId)
          if (stopped) return
          sessionId = warm.sessionId ?? sessionId
          warmCatalog = warm.catalog
          if (warm.event) yield warm.event
        } catch (err) {
          if (!(err instanceof CoachSdkFailure)) throw err
          if (stopped) return
          if (!input.sessionId) {
            yield toHarnessError(input.harness, err)
            return
          }
          // A stale resume is recoverable: discard the failed provider, create
          // a fresh session, and explicitly tell the user that context reset.
          await cleanupCurrentProvider()
          if (stopped) return
          try {
            provider = createProvider({ ...input, sessionId: undefined })
            activeProvider = provider
            providerCleanup = undefined
            if (stopped) {
              await cleanupCurrentProvider()
              return
            }
            const warm = await warmSession(provider, instanceId)
            if (stopped) return
            sessionId = warm.sessionId
            warmCatalog = warm.catalog
            restartedFresh = true
            yield {
              kind: 'notice',
              message: 'The previous session could not be resumed — continuing in a fresh session.',
            }
            if (warm.event) yield warm.event
          } catch (err2) {
            if (stopped) return
            if (!(err2 instanceof CoachSdkFailure)) throw err2
            yield toHarnessError(input.harness, err2)
            return
          }
        }

        // Progressive selection: the renderer's model/mode ids come from the
        // handshake's own selects, but the warmed session already exists, so
        // the AI SDK provider's automatic setModel/setMode (which only runs
        // inside startSession when no session exists yet) never fires for
        // this turn — apply the picks explicitly before streaming. Routing is
        // value-aware (see model-routing.ts): codex's
        // bracketed model ids decompose into base model + thinking effort via
        // `set_config_option` (provider.setModel validates against the
        // base-name config values and would throw), pi/opencode/claude models
        // via `set_config_option`, pi thinking modes via legacy `setMode`. A
        // failure is a real error event, never a silent run with the wrong
        // model. The model constructor takes the APPLIED id back from
        // model planner (a stale bracketed codex pick resolves to its
        // base), so the provider never validates a stale raw id here.
        let languageModelId = input.modelId
        if ((input.modelId || input.modeId) && sessionId) {
          try {
            const catalog = warmCatalog ?? describeCatalog(undefined)
            const policy = routingPolicyFor(input.harness.kind)
            if (input.modelId) {
              languageModelId = await executeSelectionPlan(
                selectionBoundary(provider),
                sessionId,
                planModelSelection(policy, catalog, input.modelId),
              )
            }
            if (input.modeId) {
              await executeSelectionPlan(
                selectionBoundary(provider),
                sessionId,
                planModeSelection(policy, catalog, input.modeId),
              )
            }
            if (stopped) return
          } catch (err) {
            if (err instanceof CoachSdkFailure) yield toHarnessError(input.harness, err)
            else if (err instanceof SelectionUnavailableError) yield { kind: 'error', message: err.message }
            else throw err
            return
          }
        }

        // Scoped run teardown: the controller abort + iterator drain ride
        // `runScope` (LIFO, even on failure or consumer-side `gen.return()`);
        // provider cleanup is shared with the independent stop handle and is
        // bounded before forced teardown.
        const runScope = Scope.makeUnsafe()
        const controller = new AbortController()
        activeController = controller
        let iterator: AsyncIterator<CoachStreamPart> | undefined
        let endedNormally = false
        try {
          const model = sdkSync('stream-create', () => provider.languageModel(languageModelId, input.modeId))
          const tools = sdkSync('stream-create', () => provider.tools)
          const stream = sdkSync('stream-create', () =>
            sdk.streamText({
              model,
              prompt: restartedFresh ? (input.freshPrompt ?? input.prompt) : input.prompt,
              tools,
              abortSignal: controller.signal,
            }),
          )

          // ONE iterator, used for both the loop and cancellation. Holding a
          // single handle means the Scope finalizer's return() interrupts the SAME
          // in-flight run (a second stream[Symbol.asyncIterator]() would mint a
          // fresh iterator and cancel nothing). The AI SDK's AsyncIterableStream
          // yields a plain AsyncIterator that is NOT itself async-iterable, so
          // the loop must drive it with explicit next() calls — a `for await`
          // over the held iterator throws 'not async iterable' (the fake SDK's
          // async-generator mask hides this; the real stream does not).
          iterator = sdkSync('stream-create', () => stream[Symbol.asyncIterator]()) as AsyncIterator<CoachStreamPart>
          streamIterator = iterator as AsyncIterator<CoachStreamPart> & { return?: () => Promise<unknown> }
          const normalize = createCoachEventNormalizer()
          // Abort before drain (both bounded + ignored): runs on Scope.close
          // in the outer finally, so a throw in the loop cannot skip it.
          // Abort once when cancelled, then drain when the stream exposes
          // `return()` — the two concerns are independent, so no else arm.
          await Effect.runPromise(
            Scope.addFinalizer(
              runScope,
              Effect.gen(function* () {
                if (!endedNormally) {
                  yield* Effect.sync(() => abortControllerQuietly(controller)).pipe(Effect.ignore)
                }
                const it = iterator as AsyncIterator<CoachStreamPart> & {
                  return?: () => Promise<unknown>
                }
                if (it && typeof it.return === 'function') {
                  yield* Effect.promise(() => drainStream())
                }
              }).pipe(Effect.ignore),
            ),
          )
          for (;;) {
            const { done, value } = await sdkPromise('stream-next', () => iterator!.next())
            if (done) {
              endedNormally = true
              break
            }
            // Stream-time failures (e.g. the first prompt turn hitting an
            // expired stored login) ride `error` parts — map auth walls to
            // the actionable hint here too, at the point the harness is
            // still known (events.ts stays harness-agnostic).
            for (const event of normalize(value as CoachStreamPart)) {
              yield event.kind === 'error'
                ? toHarnessError(input.harness, failureFromSdk('stream-next', event.message))
                : event
            }
          }
        } finally {
          await Effect.runPromise(Scope.close(runScope, Exit.void))
        }
      } finally {
        // ACP providers spawn a child process per provider; we never persist
        // sessions, so every run tears its agent process down (normal end,
        // error, or consumer-side cancellation) via the never-fails Effect.
        await cleanupCurrentProvider()
      }
    })()

    let sourceDone = false
    function stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopped = true
      for (const wake of stopWaiters) wake()
      stopWaiters.clear()
      try {
        activeController?.abort()
      } catch {
        // Cancellation must proceed if an SDK abort listener throws.
      }
      const cleanup = cleanupCurrentProvider()
      const drain = drainStream()
      const closeSource = Effect.runPromise(drainIteratorEffect(() => source.return(undefined), cancelDrainMs))
      stopPromise = Promise.all([cleanup, drain, closeSource]).then(() => undefined)
      return stopPromise
    }
    const events = (async function* (): AsyncGenerator<CoachEvent> {
      try {
        for (;;) {
          if (stopped) return
          const outcome = await new Promise<{ _tag: 'next'; result: IteratorResult<CoachEvent> } | { _tag: 'stopped' }>(
            (resolve, reject) => {
              let settled = false
              const waiter: { resolve?: typeof resolve; reject?: typeof reject } = { resolve, reject }
              const wake = (): void => {
                if (settled) return
                settled = true
                stopWaiters.delete(wake)
                const resume = waiter.resolve
                waiter.resolve = undefined
                waiter.reject = undefined
                resume?.({ _tag: 'stopped' })
              }
              stopWaiters.add(wake)
              // Keep the pending SDK pull independent from this consumer wait.
              // If it never settles, cancellation clears the waiter callback so
              // the abandoned Promise cannot retain the event pump.
              void source.next().then(
                result => {
                  if (settled) return
                  settled = true
                  stopWaiters.delete(wake)
                  const resume = waiter.resolve
                  waiter.resolve = undefined
                  waiter.reject = undefined
                  resume?.({ _tag: 'next', result })
                },
                err => {
                  if (settled) return
                  settled = true
                  stopWaiters.delete(wake)
                  const fail = waiter.reject
                  waiter.resolve = undefined
                  waiter.reject = undefined
                  fail?.(err)
                },
              )
            },
          )
          if (outcome._tag === 'stopped') return
          if (outcome.result.done) {
            sourceDone = true
            return
          }
          yield outcome.result.value
        }
      } finally {
        if (!stopped && !sourceDone) await stop()
      }
    })()

    return { events, stop, legacyEvents: source }
  }

  function createControlledInspection(input: HarnessProviderInput): ControlledHarnessInspection {
    let stopped = false
    let activeProvider: AcpProvider | undefined
    let providerCleanup: Promise<void> | undefined
    let stopPromise: Promise<void> | undefined
    let resolveStopped!: () => void
    const stoppedSignal = new Promise<void>(resolve => {
      resolveStopped = resolve
    })

    const cleanupProvider = (): Promise<void> => {
      if (!activeProvider) return Promise.resolve()
      providerCleanup ??= boundedProviderCleanup(activeProvider, cancelDrainMs)
      return providerCleanup
    }

    const operation = (async (): Promise<HarnessInspectResult> => {
      const provider = createProvider(input)
      activeProvider = provider
      try {
        if (stopped) throw new CoachSdkFailure({ stage: 'inspection', reason: 'cancelled', authentication: false })
        const outcome = await Effect.runPromise(
          Effect.tryPromise({
            try: () => sdkPromise('inspection', () => provider.initSession() as Promise<unknown>),
            catch: error => error,
          }).pipe(
            Effect.map(session => describeCatalog(session)),
            Effect.timeoutOption(Duration.millis(HARNESS_HANDSHAKE_TIMEOUT_MS)),
          ),
        )
        if (outcome._tag === 'None') {
          throw new CoachSdkFailure({ stage: 'inspection', reason: 'timeout', authentication: false })
        }
        if (stopped) throw new CoachSdkFailure({ stage: 'inspection', reason: 'cancelled', authentication: false })
        const catalog = outcome.value
        return {
          ...(catalog.models ? { models: catalog.models } : {}),
          ...(catalog.modes ? { modes: catalog.modes } : {}),
        }
      } finally {
        await cleanupProvider()
      }
    })()

    const result = Promise.race([
      operation,
      stoppedSignal.then(() =>
        Promise.reject(new CoachSdkFailure({ stage: 'inspection', reason: 'cancelled', authentication: false })),
      ),
    ])

    function stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopped = true
      resolveStopped()
      stopPromise = cleanupProvider()
      return stopPromise
    }

    return { result, stop }
  }

  return {
    run(input: HarnessRunInput): AsyncGenerator<CoachEvent> {
      return createControlledRun(input).legacyEvents
    },

    runControlled(input: HarnessRunInput): ControlledHarnessRun {
      return createControlledRun(input)
    },

    inspectControlled(input): ControlledHarnessInspection {
      // The same handshake a run performs — spawn + initSession — but with
      // no prompt streamed after it: read the declared selectable set and
      // the warmed session id, then tear the process down immediately (the
      // ACP session itself persists, exactly like a finished turn's). The
      // models/modes ride the same session response `run` rides on the
      // `session` CoachEvent (map 47 ticket 50), so what the pickers show
      // pre-chat is exactly what the first run would have declared anyway;
      // the session id lets the runner RESUME this warm session on that
      // first run (no double cold-start). Legacy `models`/`modes` win when
      // present; otherwise the canonical `configOptions` selects are mapped
      // (opencode and claude-agent-acp advertise models only there).
      return createControlledInspection(input)
    },

    inspect(input): Promise<HarnessInspectResult> {
      return createControlledInspection(input).result
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
