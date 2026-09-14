import { existsSync, statSync } from 'node:fs'
import type { ACPProvider, ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'
import type { CoachEvent, CoachSessionModels, CoachSessionModes } from '../../shared/schemas/agents.js'
import type { HarnessInfo } from './detect.js'
import type { AcpMcpServer } from './harnesses/types.js'
import { deriveCoachEvents, type CoachStreamPart } from './events.js'
import { harnessSpecs } from './harnesses/index.js'

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
 *  `session/set_config_option` instead — see applyConfigSelection). */
export type AcpProvider = Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'> & {
  setConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown>
}

/** The SDK surface the seam depends on — a narrow slice of `ai` +
 *  `@mcpc-tech/acp-ai-provider`. Injected so tests use a fake. */
export interface HarnessSdk {
  createACPProvider(config: AcpProviderConfig): AcpProvider
  streamText(options: {
    model: unknown
    prompt: string
    tools?: unknown
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
  /** Extra MCP servers to attach to the agent session (the injected in-app
   *  ledger server — map 53). Merged AFTER the spec's own servers. */
  mcpServers?: AcpMcpServer[]
}

export interface HarnessRunInput extends HarnessProviderInput {
  /** Agent-declared model id (from a previous session event's models).
   *  Optional — the agent runs with its own configured model when absent. */
  modelId?: string
  /** Agent-declared session mode id (from a previous session event's modes). */
  modeId?: string
  prompt: string
  /** The offered `sessionId` resume is EXPENDABLE — if loading it fails, the
   *  seam silently restarts the provider without the resume handle instead of
   *  erroring the turn. Set by the runner ONLY for a probe-warmed session
   *  (nothing was ever sent to it, so nothing is lost by restarting fresh);
   *  genuine conversation resumes stay strict — silently restarting would
   *  drop the conversation context the user expects to continue. */
  resumeIsExpendable?: boolean
}

/** The handshake probe result — from a pre-flight `initSession` with no
 *  prompt streamed. `sessionId` is the warmed session (the runner resumes it
 *  on the conversation's first run so the agent does not cold-start twice);
 *  absent `models`/`modes` mean the agent declared no such set (progressive:
 *  the pickers render only when present). */
export interface HarnessInspectResult {
  sessionId?: string
  models?: CoachSessionModels
  modes?: CoachSessionModes
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncGenerator<CoachEvent>
  /** Probes a harness's handshake-declared models/modes WITHOUT running a
   *  prompt (map 47 ticket 50): spawns the ACP provider, initSessions, reads
   *  the session response, and tears the provider down. Throws on failure
   *  (unavailable agent, auth wall) — the runner converts that to the
   *  `{ ok: false }` inspect arm, so a failed probe just leaves the pickers
   *  absent instead of blocking the chat. */
  inspect(input: HarnessProviderInput): Promise<HarnessInspectResult>
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

/** A single flat value of a session `configOptions` select (ACP spec
 *  `SessionConfigSelectOption`). `options` may also arrive grouped
 *  (`SessionConfigSelectGroup` with nested `options`) — flattenConfigOptions
 *  handles both. */
interface ConfigSelectValue {
  value: string
  name: string
  description?: string | null
}

/** The structural slice of an ACP `NewSessionResponse` the seam reads —
 *  legacy `models`/`modes` plus the canonical `configOptions` both agents
 *  under test actually use (opencode: model+mode only via configOptions;
 *  claude-agent-acp: modes legacy + model/mode/effort via configOptions).
 *  `initSession()` is typed loosely upstream, so every field is optional and
 *  validated defensively below — a malformed agent response must never throw. */
interface AcpSessionResponse {
  sessionId?: unknown
  models?: unknown
  modes?: unknown
  configOptions?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Flattens a `SessionConfigSelectOptions` payload (flat values or grouped
 *  values) into plain { value, name, description } rows. Non-conforming
 *  entries are skipped — one bad option must not drop the whole list. */
function flattenConfigOptions(options: unknown): ConfigSelectValue[] {
  if (!Array.isArray(options)) return []
  const out: ConfigSelectValue[] = []
  for (const entry of options) {
    if (!isRecord(entry)) continue
    // Grouped form: { group, name, options: [...] } — flatten with a
    // "Group / Option" label so grouped values stay distinguishable.
    if (Array.isArray(entry.options)) {
      const groupName = asString(entry.name) ?? asString(entry.group) ?? ''
      for (const nested of entry.options as unknown[]) {
        if (!isRecord(nested)) continue
        const value = asString(nested.value)
        const name = asString(nested.name)
        if (!value || !name) continue
        out.push({
          value,
          name: groupName ? `${groupName} / ${name}` : name,
          ...(typeof nested.description === 'string' ? { description: nested.description } : {}),
        })
      }
      continue
    }
    const value = asString(entry.value)
    const name = asString(entry.name)
    if (!value || !name) continue
    out.push({
      value,
      name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    })
  }
  return out
}

/** Finds the select option for a semantic category (`model` | `mode`).
 *  Category is UX-only per the ACP spec and may be missing — fall back to the
 *  conventional `id` so agents that omit it still resolve. */
function findConfigOption(session: AcpSessionResponse, category: 'model' | 'mode'): (Record<string, unknown> & { id: string }) | undefined {
  if (!Array.isArray(session.configOptions)) return undefined
  let byId: (Record<string, unknown> & { id: string }) | undefined
  for (const entry of session.configOptions as unknown[]) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const candidate = entry as Record<string, unknown> & { id: string }
    if (entry.category === category) return candidate
    if (id === category && !byId) byId = candidate
  }
  return byId
}

/** The configId to address for a category — the option's own id when the
 *  handshake advertised it, else the conventional id (resumed sessions return
 *  only `{ sessionId }`, so the id must be guessed — both live agents use the
 *  conventional `model`/`mode` ids). */
function configIdForCategory(session: AcpSessionResponse | undefined, category: 'model' | 'mode'): string | undefined {
  if (!session) return category
  return findConfigOption(session, category)?.id ?? category
}

/** Derives CoachSessionModels from a handshake response. When an agent sends
 *  both shapes, the canonical `configOptions` model select wins: Codex also
 *  sends legacy ids such as `gpt-5.6-terra[low]`, while its
 *  `session/set_config_option` endpoint accepts only `gpt-5.6-terra`. Using
 *  the legacy ids in the picker makes the next Coach turn fail with an
 *  opaque internal error. Returns undefined when the agent declared nothing
 *  usable (progressive: pickers stay absent). */
function modelsFromSession(session: AcpSessionResponse): CoachSessionModels | undefined {
  const option = findConfigOption(session, 'model')
  if (option && typeof option.currentValue === 'string' && option.currentValue.length > 0) {
    const rows = flattenConfigOptions(option.options).map(o => ({
      modelId: o.value,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
    }))
    if (rows.length > 0) return { availableModels: rows, currentModelId: option.currentValue }
  }

  if (isRecord(session.models)) {
    const available = (session.models as { availableModels?: unknown }).availableModels
    const current = (session.models as { currentModelId?: unknown }).currentModelId
    if (Array.isArray(available) && typeof current === 'string' && current.length > 0) {
      const rows = available.filter(isRecord).flatMap(entry => {
        const modelId = asString(entry.modelId)
        const name = asString(entry.name)
        return modelId && name
          ? [{ modelId, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
          : []
      })
      if (rows.length > 0) return { availableModels: rows, currentModelId: current }
    }
  }
  return undefined
}

/** Derives CoachSessionModes the same way (legacy `modes`, else the
 *  `configOptions` mode select — opencode only advertises the latter). */
function modesFromSession(session: AcpSessionResponse): CoachSessionModes | undefined {
  if (isRecord(session.modes)) {
    const available = (session.modes as { availableModes?: unknown }).availableModes
    const current = (session.modes as { currentModeId?: unknown }).currentModeId
    if (Array.isArray(available) && typeof current === 'string' && current.length > 0) {
      const rows = available.filter(isRecord).flatMap(entry => {
        const id = asString(entry.id)
        const name = asString(entry.name)
        return id && name
          ? [{ id, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
          : []
      })
      if (rows.length > 0) return { availableModes: rows, currentModeId: current }
    }
  }
  const option = findConfigOption(session, 'mode')
  if (!option || typeof option.currentValue !== 'string' || option.currentValue.length === 0) return undefined
  const rows = flattenConfigOptions(option.options).map(o => ({
    id: o.value,
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
  }))
  if (rows.length === 0) return undefined
  return { availableModes: rows, currentModeId: option.currentValue as string }
}

/** Applies a user's model/mode picks to a live session for configOptions-based
 *  agents (`session/set_config_option`). Legacy-only agents keep the existing
 *  `languageModel(modelId, modeId)` path — this only fires when the handshake
 *  advertised (or conventionally implies) a config select AND the provider
 *  exposes setConfigOption (the real SDK wrapper; fakes skip it harmlessly).
 *  Throws with the agent's message on failure so the run surfaces an error
 *  event instead of silently running with the wrong model. */
async function applyConfigSelection(
  provider: AcpProvider,
  session: AcpSessionResponse | undefined,
  sessionId: string | undefined,
  input: { modelId?: string; modeId?: string },
): Promise<void> {
  if (!sessionId || !provider.setConfigOption) return
  if (input.modelId) {
    const configId = configIdForCategory(session, 'model')
    if (configId) await provider.setConfigOption({ sessionId, configId, value: input.modelId })
  }
  if (input.modeId) {
    const configId = configIdForCategory(session, 'mode')
    if (configId) await provider.setConfigOption({ sessionId, configId, value: input.modeId })
  }
}

/** Runs one initSession on a provider and derives the session CoachEvent
 *  payload it implies (the resume handle + any handshake-declared
 *  models/modes). Shared by the main warm-up and the expendable-resume
 *  fallback so both emit the session event identically. */
async function warmSession(provider: AcpProvider): Promise<{ sessionId?: string; event?: CoachEvent; session?: AcpSessionResponse }> {
  const session = (await provider.initSession()) as unknown as AcpSessionResponse
  const sessionId = asString(session.sessionId)
  if (!sessionId) return { session }
  const event: CoachEvent = { kind: 'session', sessionId }
  const models = modelsFromSession(session)
  const modes = modesFromSession(session)
  if (models) event.models = models
  if (modes) event.modes = modes
  return { sessionId, event, session }
}

/** The env handed to the agent process: the host env MINUS the spec's
 *  scrubEnv keys (ADR 0012) — API keys are never passed, so the CLI uses its
 *  own stored login. The ACP provider's `env` is explicit, so an omitted key
 *  is genuinely absent rather than inherited. */
function scrubbedEnv(scrubEnv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !scrubEnv.includes(key)) env[key] = value
  }
  return env
}

export interface HarnessRuntimeOptions {
  /** Platform used for spawn-command wrapping (defaults to process.platform).
   *  Injectable so the win32 shim handling is unit-testable on any host. */
  platform?: NodeJS.Platform
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

export function createHarnessRuntime(sdk: HarnessSdk, options: HarnessRuntimeOptions = {}): HarnessRuntime {
  const platform = options.platform ?? process.platform

  /** Builds the ACP provider for a harness run — the ONE place the seam maps
   *  a HarnessInfo + workspace + resume handle onto `createACPProvider`
   *  (ADR 0016), shared by `run` and the `inspect` probe so both spawn the
   *  agent exactly the same way. Validates the workspace first: a bad path
   *  must fail loudly and cheaply, never as an inscrutable spawn error
   *  (ticket 15 constraint). */
  function createProvider(input: HarnessProviderInput): AcpProvider {
    assertRealWorkspacePath(input.workspacePath)

    const spec = harnessSpecs.find(s => s.kind === input.harness.kind)
    if (!spec || spec.adapter.kind !== 'acp') {
      throw new Error(`harness ${input.harness.kind} has no ACP adapter`)
    }
    const acp = spec.adapter.acpConfig

    // The ACP provider has no `shell` option — it spawns the command
    // verbatim. A BUNDLED ACP server (resolved from the app's own
    // node_modules, no global install) is run through the app's own Node
    // (`process.execPath` + ELECTRON_RUN_AS_NODE, the ledger-mcp pattern) —
    // no cmd.exe shim, no PATH lookup. PATH-resolved harnesses keep the
    // win32 shim handling below.
    const spawn = input.harness.bundledEntry
      ? { command: process.execPath, args: [input.harness.bundledEntry, ...(acp.args ?? [])] }
      : acpSpawnCommand(acp.command, acp.args ?? [], platform)

    const env = scrubbedEnv(input.harness.scrubEnv)
    // Bundled JS entries run as plain Node inside the app's binary (dev:
    // electron.exe; packaged: the app exe) — the flag is inert under real
    // Node, so tests are unaffected.
    if (input.harness.bundledEntry) env.ELECTRON_RUN_AS_NODE = '1'

    return sdk.createACPProvider({
      command: spawn.command,
      args: spawn.args,
      env,
      session: {
        cwd: input.workspacePath,
        mcpServers: [...(acp.mcpServers ?? []), ...(input.mcpServers ?? [])],
      },
      ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
      ...(acp.sessionDelayMs ? { sessionDelayMs: acp.sessionDelayMs } : {}),
      ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
    })
  }

  return {
    async *run(input: HarnessRunInput): AsyncGenerator<CoachEvent> {
      let provider = createProvider(input)

      yield { kind: 'status', state: 'starting' }

      try {
        // Warm the ACP session up front (cuts time-to-first-token) and grab
        // the resume handle. An unavailable agent (binary missing, auth wall)
        // surfaces here as a cheap error event — never an inscrutable spawn
        // crash mid-stream. The handshake may ALSO report selectable
        // models/modes — legacy `models`/`modes` or the canonical
        // `configOptions` selects (opencode and claude-agent-acp advertise
        // models only there) — those ride the session event so the renderer
        // can show a progressive picker (ticket 50).
        let sessionId: string | undefined = input.sessionId
        let warmSessionData: AcpSessionResponse | undefined
        try {
          const warm = await warmSession(provider)
          sessionId = warm.sessionId ?? sessionId
          warmSessionData = warm.session
          if (warm.event) yield warm.event
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // A failed RESUME of an EXPENDABLE session (a probe-warmed session
          // that never received any prompt) falls back to a fresh session
          // instead of failing the turn — nothing is lost, the agent just
          // cold-starts once. Genuine resumed turns stay strict: silently
          // restarting would drop the conversation context the user expects
          // to continue, so their failure remains an error event.
          if (!input.sessionId || !input.resumeIsExpendable) {
            yield { kind: 'error', message }
            return
          }
          // Tear the failed resume provider down, then rebuild the provider
          // WITHOUT the resume handle and warm a fresh session (the retry
          // config keeps everything else — model/mode picks, the ledger MCP
          // server — so the fresh session behaves like a normal first run).
          // The provider creation sits INSIDE the try: a throw there becomes
          // a graceful error event, never an uncaught generator rejection.
          provider.cleanup()
          try {
            provider = createProvider({ ...input, sessionId: undefined })
            const warm = await warmSession(provider)
            sessionId = warm.sessionId
            warmSessionData = warm.session
            if (warm.event) yield warm.event
          } catch (err2) {
            yield { kind: 'error', message: err2 instanceof Error ? err2.message : String(err2) }
            return
          }
        }

        // Progressive selection for configOptions-based agents: the renderer's
        // model/mode ids come from the handshake's own selects, but the AI SDK
        // provider only knows the legacy `unstable_setSessionModel` /
        // `setSessionMode` calls (claude-agent-acp rejects the former with
        // "Method not found"). Apply the picks explicitly via
        // `session/set_config_option` before streaming — a failure is a real
        // error event, never a silent run with the wrong model.
        if ((input.modelId || input.modeId) && sessionId) {
          try {
            await applyConfigSelection(provider, warmSessionData, sessionId, input)
          } catch (err) {
            yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
            return
          }
        }

        const stream = sdk.streamText({
          model: provider.languageModel(input.modelId, input.modeId),
          prompt: input.prompt,
          tools: provider.tools,
        })

        // ONE iterator, used for both the loop and cancellation. Holding a
        // single handle means the finally's return() interrupts the SAME
        // in-flight run (a second stream[Symbol.asyncIterator]() would mint a
        // fresh iterator and cancel nothing). The AI SDK's AsyncIterableStream
        // yields a plain AsyncIterator that is NOT itself async-iterable, so
        // the loop must drive it with explicit next() calls — a `for await`
        // over the held iterator throws 'not async iterable' (the fake SDK's
        // async-generator mask hides this; the real stream does not).
        const iterator = stream[Symbol.asyncIterator]()
        try {
          for (;;) {
            const { done, value } = await iterator.next()
            if (done) break
            yield* deriveCoachEvents(value as CoachStreamPart)
          }
        } finally {
          if (typeof iterator.return === 'function') {
            await iterator.return()
          }
        }
      } finally {
        // ACP providers spawn a child process per provider; we never persist
        // sessions, so every run tears its agent process down (normal end,
        // error, or consumer-side cancellation).
        provider.cleanup()
      }
    },

    async inspect(input): Promise<HarnessInspectResult> {
      const provider = createProvider(input)
      try {
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
        const session = (await provider.initSession()) as unknown as AcpSessionResponse
        const models = modelsFromSession(session)
        const modes = modesFromSession(session)
        return {
          ...(asString(session.sessionId) ? { sessionId: session.sessionId as string } : {}),
          ...(models ? { models } : {}),
          ...(modes ? { modes } : {}),
        }
      } finally {
        provider.cleanup()
      }
    },
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
  ])
  return {
    // The real factory's signature IS `(config: ACPProviderSettings) =>
    // ACPProvider` — the seam's `AcpProviderConfig`/`AcpProvider` are that
    // real type (map 47 ticket 51), so no cast is needed at this boundary
    // except for the additive setConfigOption augmentation below.
    createACPProvider: ((config: AcpProviderConfig): AcpProvider => {
      const provider = createACPProvider(config) as unknown as AcpProvider & {
        model?: { connection?: { setSessionConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown> } }
      }
      provider.setConfigOption = async (args: { sessionId: string; configId: string; value: string }) => {
        const connection = provider.model?.connection
        if (!connection?.setSessionConfigOption) {
          throw new Error('agent does not support session config options')
        }
        return connection.setSessionConfigOption(args)
      }
      return provider
    }) as HarnessSdk['createACPProvider'],
    streamText: (options: {
      model: unknown
      prompt: string
      tools?: unknown
    }) => streamText(options as unknown as Parameters<typeof streamText>[0]).fullStream as unknown as AsyncIterable<CoachStreamPart>,
  }
}
