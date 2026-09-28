import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { CommandError, CommandRunner } from './command-runner.js'
import type { HarnessAuthStatus } from './detect.js'

/**
 * Claude Code sign-in probe (auth wall early signal): asks the BASE `claude`
 * CLI for its own login state (`claude auth status --json`) and maps it onto
 * the registry's `HarnessAuthStatus`. Detection (`registerAgentsIpc`) passes
 * this as the `authProbe` for the `claude` kind, so the Coach picker shows an
 * honest state BEFORE any run — the ACP handshake (`initSession`) reports
 * models/modes without authenticating, so a populated model picker alone
 * never proves the harness can run.
 *
 * Reads ONLY the `loggedIn` boolean — no token material is parsed, stored,
 * or forwarded. Never throws and never blocks detection: every failure mode
 * (CLI missing, timeout, unparseable output, spawn error) resolves to
 * `'unknown'`, which the picker treats exactly like before (all detected
 * harnesses stay drivable; only the default-pick preference is affected).
 *
 * The CLI prints valid JSON on stdout even when it exits non-zero (the
 * logged-out case exits 1), so the exit code is deliberately ignored — only
 * the parsed `loggedIn` field decides.
 *
 * Wave 9 (issue #148), §5.3 `Command` step: the `node:child_process.execFile`
 * call and its `timeout` option are gone, replaced by the `CommandRunner`
 * port (`src/main/agents/command-runner.ts`) built on the in-package
 * `effect/unstable/process` modules. The deadline now rides the Effect Clock
 * as the port's `timeoutMs`, so a hung child is KILLED (scope finalizer) and
 * no `setTimeout` is involved. The Windows `.cmd` shim and the `which()` PATH
 * lookup are DOMAIN CODE called by that port's live layer, unchanged — so
 * this module is now pure: run the command, parse the JSON, map the boolean.
 */

/** Upper bound on one `claude auth status --json` run, matching the agent's
 *  own probe budget (`AUTH_STATUS_PROBE_TIMEOUT_MS` in claude-agent-acp) so a
 *  hung CLI cannot wedge harness detection. Single source of truth: it is
 *  handed to the port as the run's Clock deadline, not restated as a literal
 *  at a second deadline. */
export const CLAUDE_AUTH_PROBE_TIMEOUT_MS = 5000

/** Injectable process runner — the default shells the real CLI through the
 * `CommandRunner` port; tests inject a fake. Resolves with stdout even on
 * non-zero exit (see above); rejects only when nothing could run (spawn
 * failure, timeout). */
export type AuthProbeExec = (command: string, args: readonly string[]) => Promise<{ stdout: string }>

/** The argv the probe asks the CLI for. Unchanged since the `execFile` era. */
const PROBE_COMMAND = 'claude'
const PROBE_ARGS: readonly string[] = ['auth', 'status', '--json']

/** Maps one captured stdout onto the registry auth status. Pure and
 *  never-throwing: the JSON contract is the `loggedIn` boolean only, the exit
 *  code is irrelevant (logged-out exits 1), and anything unparseable or
 *  signal-free is `'unknown'`. */
function statusFromStdout(stdout: string): HarnessAuthStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'unknown'
  const record = parsed as Record<string, unknown>
  if (record.loggedIn === true) return 'configured'
  if (record.loggedIn === false) return 'unauthenticated'
  return 'unknown'
}

/** One captured run: stdout, or a typed failure when nothing could run. The
 *  port already bounds the run with the SAME constant; the second deadline is
 *  the belt-and-braces guarantee that the probe cannot hang even behind a
 *  runner that ignores `timeoutMs`, and it costs one `Option` check. */
function captureStdout(command: string, args: readonly string[]): Effect.Effect<string, CommandError, CommandRunner> {
  return Effect.gen(function* () {
    const runner = yield* CommandRunner
    // `timeoutOption` keeps the source's error channel, so a spawn failure
    // stays the port's own `CommandError` and only the outer deadline has to
    // be synthesized here.
    const outcome = yield* runner
      .run(command, args, { timeoutMs: CLAUDE_AUTH_PROBE_TIMEOUT_MS })
      .pipe(Effect.timeoutOption(Duration.millis(CLAUDE_AUTH_PROBE_TIMEOUT_MS)))
    if (Option.isNone(outcome)) {
      return yield* new CommandError({
        reason: 'timeout',
        message: `auth probe timed out after ${CLAUDE_AUTH_PROBE_TIMEOUT_MS}ms`,
        command,
      })
    }
    return outcome.value.stdout
  })
}

/**
 * The probe as an Effect over the port: the same mapping and the same
 * never-throw guarantee, with the port's `CommandError` collapsed to
 * `'unknown'`. Exported so the probe→port wiring is testable against a fake
 * runner (no harness CLI required) and so the Effect-native shape is already
 * in the file for the slice that removes the Promise adapter.
 */
export function runClaudeAuthProbe(
  command: string,
  args: readonly string[],
): Effect.Effect<HarnessAuthStatus, never, CommandRunner> {
  return captureStdout(command, args).pipe(
    Effect.map(statusFromStdout),
    Effect.catchTag('CommandError', (): Effect.Effect<HarnessAuthStatus> => Effect.succeed('unknown')),
  )
}

/**
 * The live exec: the port's spawn, surfaced at the module's Promise boundary.
 *
 * This is the ONE compatibility adapter of the slice, and it is a Promise
 * adapter rather than a second runtime. `probeClaudeAuthStatus` must keep its
 * `Promise<HarnessAuthStatus>` signature and its `AuthProbeExec` injection
 * point because `probe.ts`'s `authFromInitialize` calls it with no arguments
 * through a Promise-typed `ProbeDeps.claudeAuthProbe` — a file this slice may
 * not edit, and the reason the probe cannot simply reach for the main runtime
 * (`MainLive` → `HarnessProbe` → `probeHarness` → this module is an import
 * cycle). `CommandRunner.layer` owns no scoped resources — the child is scoped
 * to the single `run` call — so building it per probe is cheap, and the isolate
 * still has exactly ONE `ManagedRuntime`.
 *
 * Named removal condition: this adapter, the `CommandRunner.layer` provide
 * below, and the `AuthProbeExec` injection point all delete together when
 * `authFromInitialize` accepts an Effect-returning auth probe instead — i.e.
 * when the harness probe seam is re-skinned. At that point the live runner is
 * provided once by the main runtime (`MainLive`) and the probe runs inside the
 * caller's fiber; until then this is the only place the live layer is built.
 */
function defaultExec(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  return Effect.runPromise(
    captureStdout(command, args).pipe(
      Effect.map(stdout => ({ stdout })),
      Effect.provide(CommandRunner.layer),
    ),
  )
}

/** Runs the probe and maps it to the registry auth status. Never rejects. */
export async function probeClaudeAuthStatus(exec: AuthProbeExec = defaultExec): Promise<HarnessAuthStatus> {
  try {
    const { stdout } = await exec(PROBE_COMMAND, PROBE_ARGS)
    return statusFromStdout(stdout)
  } catch {
    return 'unknown'
  }
}
