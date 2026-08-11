import { existsSync, statSync } from 'node:fs'
import type { CoachEvent } from '../../shared/schemas/agents.js'
import type { HarnessInfo } from './detect.js'
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
 * `adapter.acpConfig` maps 1:1 to `createACPProvider` settings; the seam adds
 * the per-run `session.cwd` (the real workspace) and the scrubbed env
 * (ADR 0012 — the agent falls back to its own stored login). There is no
 * sandbox middleware: ACP agents run locally against the workspace.
 *
 * Packaging constraint (ticket 15): the workspace source must be a REAL
 * on-disk path, never a virtual asar path (child processes cannot read asar).
 * `run` validates this before the SDK is touched.
 */

/** The `createACPProvider` settings subset the seam needs — narrow slice of
 *  ACPProviderSettings (@mcpc-tech/acp-ai-provider), kept local so the seam
 *  stays SDK-version-agnostic. */
export interface AcpProviderConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  session: { cwd: string; mcpServers: unknown[] }
  authMethodId?: string
  existingSessionId?: string
}

/** The ACP provider surface the seam depends on — narrow slice of ACPProvider. */
export interface AcpProvider {
  languageModel(modelId?: string): unknown
  tools?: unknown
  initSession(): Promise<{ sessionId: string }>
  cleanup(): void
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

export interface HarnessRunInput {
  harness: HarnessInfo
  model: string
  /** The user's project repo — must be a real on-disk directory. */
  workspacePath: string
  prompt: string
  /** Resume handle from a previous run's session event. */
  sessionId?: string
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

export function createHarnessRuntime(sdk: HarnessSdk): HarnessRuntime {
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

      const provider = sdk.createACPProvider({
        command: acp.command,
        args: acp.args ?? [],
        env: scrubbedEnv(input.harness.scrubEnv),
        session: { cwd: input.workspacePath, mcpServers: acp.mcpServers ?? [] },
        ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
        ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
      })

      yield { kind: 'status', state: 'starting' }

      try {
        // Warm the ACP session up front (cuts time-to-first-token) and grab
        // the resume handle. An unavailable agent (binary missing, auth wall)
        // surfaces here as a cheap error event — never an inscrutable spawn
        // crash mid-stream.
        let sessionId: string | undefined = input.sessionId
        try {
          const session = await provider.initSession()
          sessionId = session.sessionId ?? sessionId
        } catch (err) {
          yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
          return
        }
        if (sessionId) yield { kind: 'session', sessionId }

        const stream = sdk.streamText({
          model: provider.languageModel(input.model),
          prompt: input.prompt,
          tools: provider.tools,
        })

        // ONE iterator, used for both the loop and cancellation. Holding a
        // single handle means the finally's return() interrupts the SAME
        // in-flight run (a second stream[Symbol.asyncIterator]() would mint a
        // fresh iterator and cancel nothing). TS needs the cast because
        // `for await` requires an AsyncIterable while the held handle is an
        // AsyncIterator.
        const iterator = stream[Symbol.asyncIterator]()
        try {
          for await (const part of iterator as unknown as AsyncIterable<CoachStreamPart>) {
            yield* deriveCoachEvents(part)
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
    createACPProvider: (config: AcpProviderConfig) =>
      createACPProvider(config as unknown as Parameters<typeof createACPProvider>[0]) as unknown as AcpProvider,
    streamText: (options: {
      model: unknown
      prompt: string
      tools?: unknown
    }) => streamText(options as unknown as Parameters<typeof streamText>[0]).fullStream as unknown as AsyncIterable<CoachStreamPart>,
  }
}
