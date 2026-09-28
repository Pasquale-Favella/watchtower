import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import {
  type AuthProbeExec,
  CLAUDE_AUTH_PROBE_TIMEOUT_MS,
  probeClaudeAuthStatus,
  runClaudeAuthProbe,
} from '../src/main/agents/auth-probe.js'
import { CommandError, makeRecordingCommandRunner } from '../src/main/agents/command-runner.js'
import type { HarnessAuthStatus } from '../src/main/agents/detect.js'
import type { ProbeAuthStatus, ProbeDeps } from '../src/main/agents/probe.js'

/**
 * Claude Code sign-in probe: maps `claude auth status --json` onto the
 * registry auth status, reading ONLY the loggedIn boolean. Every failure
 * mode resolves to 'unknown' — the probe must never throw into detection.
 *
 * Wave 9 (issue #148) re-skinned the spawn onto the `CommandRunner` port
 * (`src/main/agents/command-runner.ts`). Two contracts are pinned here:
 * the legacy Promise boundary (`AuthProbeExec`, so `probe.ts:118` compiles
 * with zero edits) and the port wiring (the argv, the single-source
 * deadline, and the never-throw mapping). No harness CLI is spawned: the
 * port is faked with `makeRecordingCommandRunner`.
 */
describe('probeClaudeAuthStatus — Claude Code sign-in probe (loggedIn boolean only)', () => {
  it('reports configured when the CLI reports loggedIn:true', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty' }),
    }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('configured')
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'])
  })

  it('reports unauthenticated when logged out (the CLI exits 1 but still prints JSON)', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
    }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('unauthenticated')
  })

  it('reports unknown on unparseable output', async () => {
    const exec = vi.fn(async () => ({ stdout: 'not json' }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('unknown')
  })

  it('reports unknown when the CLI is missing, hangs, or the output has no login signal', async () => {
    const missing = vi.fn(async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    })
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    })
    const empty = vi.fn(async () => ({ stdout: JSON.stringify({ apiProvider: 'firstParty' }) }))

    await expect(probeClaudeAuthStatus(missing)).resolves.toBe('unknown')
    await expect(probeClaudeAuthStatus(timeout)).resolves.toBe('unknown')
    await expect(probeClaudeAuthStatus(empty)).resolves.toBe('unknown')
  })

  it('bounds the probe so a hung CLI cannot wedge harness detection', () => {
    expect(CLAUDE_AUTH_PROBE_TIMEOUT_MS).toBe(5000)
  })

  it('never rejects, even when the runner throws something that is not an Error', async () => {
    const exec = vi.fn(async () => {
      throw 'a bare string, not an Error'
    })
    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('unknown')
  })

  // The Promise boundary is a hard contract of this slice: `probe.ts:118`
  // calls the probe with no arguments through the Promise-typed
  // `ProbeDeps.claudeAuthProbe`, and that file may not be edited. These two
  // type-only assertions fail the build if either signature drifts.
  it('keeps the Promise boundary and the AuthProbeExec injection point', () => {
    const asProbeAuth: (exec?: AuthProbeExec) => Promise<HarnessAuthStatus> = probeClaudeAuthStatus
    const asHarnessDep: NonNullable<ProbeDeps['claudeAuthProbe']> = probeClaudeAuthStatus
    void asProbeAuth
    void asHarnessDep
    // `HarnessAuthStatus` (detect) and `ProbeAuthStatus` (probe) are the same
    // closed union — the registry type, not a probe-local copy.
    const registry: readonly ProbeAuthStatus[] = ['configured', 'unauthenticated', 'unknown']
    expect(registry).toHaveLength(3)
  })
})

describe('runClaudeAuthProbe — the same probe over the CommandRunner port', () => {
  const PROBE = ['auth', 'status', '--json'] as const

  const runWith = (respond: Parameters<typeof makeRecordingCommandRunner>[0]) => {
    const { layer, calls } = makeRecordingCommandRunner(respond)
    return { calls, status: Effect.runPromise(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer))) }
  }

  it('asks the CLI for the documented argv with the single-source deadline', async () => {
    const { calls, status } = runWith(() => Effect.succeed({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 }))
    await expect(status).resolves.toBe('configured')
    expect(calls).toEqual([{ command: 'claude', args: PROBE, options: { timeoutMs: 5000 } }])
  })

  it('reads a logged-out non-zero exit as unauthenticated (the exit code is ignored)', async () => {
    const { status } = runWith(() => Effect.succeed({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 }))
    await expect(status).resolves.toBe('unauthenticated')
  })

  it('collapses a missing CLI (port spawn failure) to unknown', async () => {
    const { status } = runWith(() =>
      Effect.fail(new CommandError({ reason: 'spawn', message: 'spawn claude ENOENT', command: 'claude' })),
    )
    await expect(status).resolves.toBe('unknown')
  })

  it('collapses a hung CLI (port timeout) to unknown', async () => {
    const { status } = runWith(() =>
      Effect.fail(new CommandError({ reason: 'timeout', message: 'claude timed out after 5000ms', command: 'claude' })),
    )
    await expect(status).resolves.toBe('unknown')
  })

  it('collapses unparseable and signal-free stdout to unknown', async () => {
    await expect(runWith(() => Effect.succeed({ stdout: 'not json', exitCode: 0 })).status).resolves.toBe('unknown')
    await expect(
      runWith(() => Effect.succeed({ stdout: JSON.stringify({ apiProvider: 'firstParty' }), exitCode: 0 })).status,
    ).resolves.toBe('unknown')
    await expect(runWith(() => Effect.succeed({ stdout: '', exitCode: 1 })).status).resolves.toBe('unknown')
    await expect(runWith(() => Effect.succeed({ stdout: 'null', exitCode: 0 })).status).resolves.toBe('unknown')
  })
})
