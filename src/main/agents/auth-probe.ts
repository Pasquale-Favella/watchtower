import { execFile } from 'node:child_process'
import type { HarnessAuthStatus } from './detect.js'
import { which } from './detect.js'
import { acpSpawnCommand } from './runtime.js'

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
 * (CLI missing, timeout, unparseable output) resolves to `'unknown'`, which
 * the picker treats exactly like before (all detected harnesses stay
 * drivable; only the default-pick preference is affected).
 *
 * The CLI prints valid JSON on stdout even when it exits non-zero (the
 * logged-out case exits 1), so the exit code is deliberately ignored — only
 * the parsed `loggedIn` field decides.
 */

/** Upper bound on one `claude auth status --json` run, matching the agent's
 *  own probe budget (`AUTH_STATUS_PROBE_TIMEOUT_MS` in claude-agent-acp) so a
 *  hung CLI cannot wedge harness detection. */
export const CLAUDE_AUTH_PROBE_TIMEOUT_MS = 5000

/** Injectable process runner — the default shells the real CLI; tests inject
 *  a fake. Resolves with stdout even on non-zero exit (see above); rejects
 *  only when nothing could run (spawn failure, timeout). */
export type AuthProbeExec = (command: string, args: readonly string[]) => Promise<{ stdout: string }>

function defaultExec(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    // Same Windows shim constraint as agent spawns — reuse the shared helper
    // so npm-global `.cmd` shims resolve under `cmd.exe /c`.
    const bin = which(command) ?? command
    const spawn = acpSpawnCommand(bin, args, process.platform)
    execFile(spawn.command, spawn.args, { timeout: CLAUDE_AUTH_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const text = typeof stdout === 'string' ? stdout : String(stdout ?? '')
      const failure = error as { killed?: boolean; code?: string | number } | null
      if (error && (failure?.killed || failure?.code === 'ETIMEDOUT')) {
        reject(error)
        return
      }
      // Non-zero exit still carries the JSON status on stdout (logged-out
      // exits 1) — resolve and let the parser decide.
      resolve({ stdout: text })
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Runs the probe and maps it to the registry auth status. Never rejects. */
export async function probeClaudeAuthStatus(exec: AuthProbeExec = defaultExec): Promise<HarnessAuthStatus> {
  try {
    const { stdout } = await exec('claude', ['auth', 'status', '--json'])
    const parsed: unknown = JSON.parse(stdout)
    if (isRecord(parsed) && parsed.loggedIn === true) return 'configured'
    if (isRecord(parsed) && parsed.loggedIn === false) return 'unauthenticated'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
