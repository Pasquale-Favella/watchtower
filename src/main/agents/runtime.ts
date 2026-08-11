import { existsSync, statSync } from 'node:fs'
import type { ACPProvider, ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'
import type { CoachEvent } from '../../shared/schemas/agents.js'
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

/** The provider surface the seam uses — a structural Pick of the real class. */
export type AcpProvider = Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'>

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

export interface HarnessRunInput {
  harness: HarnessInfo
  /** Agent-declared model id (from a previous session event's models).
   *  Optional — the agent runs with its own configured model when absent. */
  modelId?: string
  /** Agent-declared session mode id (from a previous session event's modes). */
  modeId?: string
  /** The user's project repo — must be a real on-disk directory. */
  workspacePath: string
  prompt: string
  /** Resume handle from a previous run's session event. */
  sessionId?: string
  /** Extra MCP servers to attach to the agent session (the injected in-app
   *  ledger server — map 53). Merged AFTER the spec's own servers. */
  mcpServers?: AcpMcpServer[]
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncGenerator<CoachEvent>
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
  return {
    async *run(input: HarnessRunInput): AsyncGenerator<CoachEvent> {
      // Validate before touching the SDK: a bad workspace must fail loudly and
      // cheaply, never as an inscrutable spawn error (ticket 15 constraint).
      assertRealWorkspacePath(input.workspacePath)

      const spec = harnessSpecs.find(s => s.kind === input.harness.kind)
      if (!spec || spec.adapter.kind !== 'acp') {
        throw new Error(`harness ${input.harness.kind} has no ACP adapter`)
      }
      const acp = spec.adapter.acpConfig

      // The ACP provider has no `shell` option — it spawns the command
      // verbatim. On Windows, npm-shim CLIs must go through cmd.exe /c.
      const spawn = acpSpawnCommand(acp.command, acp.args ?? [], platform)

      const provider = sdk.createACPProvider({
        command: spawn.command,
        args: spawn.args,
        env: scrubbedEnv(input.harness.scrubEnv),
        session: {
          cwd: input.workspacePath,
          mcpServers: [...(acp.mcpServers ?? []), ...(input.mcpServers ?? [])],
        },
        ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
        ...(acp.sessionDelayMs ? { sessionDelayMs: acp.sessionDelayMs } : {}),
        ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
      })

      yield { kind: 'status', state: 'starting' }

      try {
        // Warm the ACP session up front (cuts time-to-first-token) and grab
        // the resume handle. An unavailable agent (binary missing, auth wall)
        // surfaces here as a cheap error event — never an inscrutable spawn
        // crash mid-stream. The handshake may ALSO report selectable
        // models/modes (experimental ACP fields) — those ride the session
        // event so the renderer can show a progressive picker (ticket 50).
        let sessionId: string | undefined = input.sessionId
        try {
          const session = await provider.initSession()
          sessionId = session.sessionId ?? sessionId
          if (sessionId) {
            const event: CoachEvent = { kind: 'session', sessionId }
            if (session.models) event.models = session.models
            if (session.modes) event.modes = session.modes
            yield event
          }
        } catch (err) {
          yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
          return
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
  }
}

/** Wire the REAL AI SDK + ACP provider lazily (ESM packages, dynamic import
 *  so the seam's import surface stays light and the app boots without them).
 *  The seam has zero per-harness adapter-wiring code (ADR 0016): every spec
 *  carries its own ACP descriptor, and `createHarnessRuntime` reads it. */
export async function loadHarnessSdk(): Promise<HarnessSdk> {
  const [{ streamText }, { createACPProvider }] = await Promise.all([
    import('ai'),
    import('@mcpc-tech/acp-ai-provider'),
  ])
  return {
    // The real factory's signature IS `(config: ACPProviderSettings) =>
    // ACPProvider` — the seam's `AcpProviderConfig`/`AcpProvider` are that
    // real type (map 47 ticket 51), so no cast is needed at this boundary.
    createACPProvider,
    streamText: (options: {
      model: unknown
      prompt: string
      tools?: unknown
    }) => streamText(options as unknown as Parameters<typeof streamText>[0]).fullStream as unknown as AsyncIterable<CoachStreamPart>,
  }
}
