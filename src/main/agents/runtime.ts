import { existsSync, statSync } from 'node:fs'
import type { StreamChunk } from '@tanstack/ai'
import type { CoachEvent } from '../../shared/schemas/agents.js'
import type { HarnessInfo } from './detect.js'
import { deriveCoachEvents } from './events.js'

/**
 * The HarnessRuntime seam (ticket 18/20): the single main-process module that
 * owns the TanStack AI SDK — sandbox creation, harness adapters, and AG-UI
 * streaming — and derives the typed CoachEvent stream the renderer consumes.
 * The renderer never touches the SDK. The SDK surface is injected (ADR 0006
 * isolation), so the 0.x dependency stays swappable and the seam is testable
 * with a fake SDK; `loadHarnessSdk()` wires the real packages lazily.
 *
 * Packaging constraint (ticket 15): the workspace source must be a REAL
 * on-disk path, never a virtual asar path (child processes cannot read asar).
 * `run` validates this before the SDK is touched.
 */

/** The SDK surface the seam depends on — a narrow slice of @tanstack/ai +
 *  ai-sandbox + the per-harness adapters. Injected so tests use a fake. */
export interface HarnessSdk {
  chat(options: {
    adapter: unknown
    messages: Array<{ role: 'user'; content: string }>
    middleware?: unknown[]
  }): AsyncIterable<StreamChunk>
  defineSandbox(config: {
    id: string
    provider: unknown
    workspace?: unknown
    lifecycle?: unknown
  }): unknown
  defineWorkspace(definition: { source: { type: 'local'; path: string } }): unknown
  localProcessSandbox(config?: { scrubEnv?: string[] }): unknown
  withSandbox(sandbox: unknown): unknown
  adapters: Record<HarnessInfo['kind'], (model: string, config?: Record<string, unknown>) => unknown>
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
  // Segment-aware: reject a path whose *segment* is an asar archive (a packaged
  // virtual path), not any path merely containing the substring '.asar'.
  const segments = workspacePath.split(/[/\\]/)
  if (segments.some(segment => segment.endsWith('.asar'))) {
    throw new Error(`workspace must be a real on-disk path, never an asar path: ${workspacePath}`)
  }
}

export function createHarnessRuntime(sdk: HarnessSdk): HarnessRuntime {
  return {
    async *run(input: HarnessRunInput): AsyncGenerator<CoachEvent> {
      // Validate before touching the SDK: a bad workspace must fail loudly and
      // cheaply, never as an inscrutable spawn error (ticket 15 constraint).
      assertRealWorkspacePath(input.workspacePath)

      const sandbox = sdk.defineSandbox({
        id: `watchtower-${input.harness.kind}`,
        provider: sdk.localProcessSandbox({ scrubEnv: [...input.harness.scrubEnv] }),
        workspace: sdk.defineWorkspace({ source: { type: 'local', path: input.workspacePath } }),
        lifecycle: { reuse: 'thread' },
      })

      const adapter = sdk.adapters[input.harness.kind](input.model)
      const stream = sdk.chat({
        adapter,
        messages: [{ role: 'user', content: input.prompt }],
        middleware: [sdk.withSandbox(sandbox)],
      })

      // ONE iterator, used for both the loop and cancellation. Holding a single
      // handle means the finally's return() interrupts the SAME in-flight run
      // (a second stream[Symbol.asyncIterator]() would mint a fresh iterator and
      // cancel nothing). TS needs the cast because `for await` requires an
      // AsyncIterable while the held handle is an AsyncIterator.
      const iterator = stream[Symbol.asyncIterator]()
      try {
        for await (const chunk of iterator as unknown as AsyncIterable<StreamChunk>) {
          yield* deriveCoachEvents(chunk)
        }
      } finally {
        // Consumer-side cancellation (break / .return() on this generator)
        // propagates to the SDK stream, giving the harness a native
        // interruption (ticket 18: cancel = stream.return()).
        if (typeof iterator.return === 'function') {
          await iterator.return()
        }
      }
    },
  }
}

/** Wire the REAL TanStack AI SDK lazily (ESM-only packages, dynamic import so
 *  the seam's import surface stays light and the app boots without them). */
export async function loadHarnessSdk(): Promise<HarnessSdk> {
  const [{ chat }, sandbox, localProcess, adapters] = await Promise.all([
    import('@tanstack/ai'),
    import('@tanstack/ai-sandbox'),
    import('@tanstack/ai-sandbox-local-process'),
    Promise.all([
      import('@tanstack/ai-claude-code'),
      import('@tanstack/ai-opencode'),
      import('@tanstack/ai-codex'),
    ]),
  ])
  const [claudeCode, opencode, codex] = adapters
  return {
    chat: chat as HarnessSdk['chat'],
    defineSandbox: sandbox.defineSandbox as HarnessSdk['defineSandbox'],
    defineWorkspace: sandbox.defineWorkspace as HarnessSdk['defineWorkspace'],
    localProcessSandbox: localProcess.localProcessSandbox as HarnessSdk['localProcessSandbox'],
    withSandbox: sandbox.withSandbox as HarnessSdk['withSandbox'],
    adapters: {
      // The adapter model types end in `(string & {})` (an escape hatch), which
      // TS normalizes to `string`, so a plain string satisfies the constraint.
      claude: (model, config = {}) =>
        claudeCode.claudeCodeText(model, { permissionMode: 'acceptEdits', ...config }),
      opencode: (model, config = {}) =>
        opencode.opencodeText(model, { permissionMode: 'acceptEdits', ...config }),
      codex: (model, config = {}) =>
        codex.codexText(model, { approvalPolicy: 'untrusted', ...config }),
    },
  }
}
