import { type ChildProcessWithoutNullStreams, execFile, spawn as spawnProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import {
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { probeClaudeAuthStatus, runClaudeAuthProbe } from './auth-probe.js'
import type { CommandRunner } from './command-runner.js'
import type { HarnessInfo } from './detect.js'
import { probeTimeoutFor } from './harness-timeouts.js'
import { killProcessTree } from './process-tree.js'
import { createHarnessSpawn, type HarnessSpawn } from './runtime.js'

export type ProbeStatus = 'pending' | 'ready' | 'warning' | 'error' | 'disabled'
export type ProbeAuthStatus = 'configured' | 'unauthenticated' | 'unknown'

export interface ProbeResult {
  status: Exclude<ProbeStatus, 'pending'>
  auth: { status: ProbeAuthStatus; label?: string }
  version?: string
  message?: string
}

export interface ProbeChild {
  pid?: number
  stdin?: Writable
  stdout?: Readable
  stderr?: Readable
  on(event: 'error', listener: (error: Error) => void): ProbeChild
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): ProbeChild
  kill: (signal?: NodeJS.Signals) => boolean
}

export interface ProbeConnection {
  initialize: (params: {
    protocolVersion: number
    clientInfo: { name: string; version: string }
    clientCapabilities: Record<string, never>
  }) => Promise<InitializeResponse>
}

export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: HarnessSpawn & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ProbeChild
export type ProbeConnectionFactory = (child: ProbeChild) => ProbeConnection

export interface ProbeDeps {
  spawn?: ProbeSpawn
  connectionFactory?: ProbeConnectionFactory
  claudeAuthProbe?: () => Promise<ProbeAuthStatus>
  kill?: (child: ProbeChild, platform: NodeJS.Platform) => void
  execFile?: typeof execFile
  clientVersion?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
}

/** Expected transport outcomes that can safely cross the Coach probe boundary. */
export class ProbeOperationalFailure extends Schema.TaggedError<ProbeOperationalFailure>()('ProbeOperationalFailure', {
  reason: Schema.Literals(['spawn', 'connect', 'handshake', 'child-exit', 'deadline', 'auth']),
  timeoutMs: Schema.optional(Schema.Number),
}) {}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: HarnessSpawn & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessWithoutNullStreams {
  return spawnProcess(command, [...args], options)
}

function defaultConnectionFactory(child: ProbeChild): ProbeConnection {
  if (!child.stdin || !child.stdout) throw new Error('ACP child did not expose stdio pipes')
  const client: Client = {
    requestPermission: async () => {
      throw new Error('permissions are unavailable during a harness probe')
    },
    sessionUpdate: async () => {},
  }
  // Node's declaration adds iterator members the ACP SDK's DOM stream type omits.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as Parameters<typeof ndJsonStream>[1],
  )
  return new ClientSideConnection(() => client, stream)
}

function killProbeChild(child: ProbeChild, platform: NodeJS.Platform, runExecFile: typeof execFile = execFile): void {
  if (platform === 'win32' && child.pid !== undefined) {
    void killProcessTree(child.pid, platform, runExecFile)
    return
  }
  child.kill('SIGTERM')
}

function failureMessage(info: HarnessInfo, failure: ProbeOperationalFailure): string {
  switch (failure.reason) {
    case 'spawn':
      return `${info.displayName} could not be started. Check that it is installed and available on PATH.`
    case 'connect':
      return `${info.displayName} could not connect to its ACP process. Check the installation and try again.`
    case 'handshake':
      return `${info.displayName} did not complete the ACP handshake. Check the installation and try again.`
    case 'child-exit':
      return `${info.displayName} exited before completing the ACP handshake. Try restarting it.`
    case 'deadline':
      return `${info.displayName} did not answer the ACP handshake within ${(failure.timeoutMs ?? 0) / 1000}s.`
    case 'auth':
      return `${info.displayName} sign-in could not be verified. Run \`claude auth status\` and sign in if needed.`
  }
}

function errorResult(info: HarnessInfo, failure: ProbeOperationalFailure): ProbeResult {
  return {
    status: 'error',
    auth: { status: 'unknown' },
    message: failureMessage(info, failure),
  }
}

function handshakeResult(info: HarnessInfo, auth: ProbeAuthStatus, version?: string): ProbeResult {
  // Only a probe that can actually tell (Claude) marks a harness signed out; an unverifiable
  // sign-in stays ready and is learned from the first run (snapshot `reportAuth`).
  return {
    status: auth === 'unauthenticated' ? 'warning' : 'ready',
    auth: { status: auth },
    ...(version ? { version } : {}),
    ...(auth === 'unauthenticated' ? { message: `${info.displayName} is not signed in` } : {}),
  }
}

function authFromInitialize(
  info: HarnessInfo,
  deps: ProbeDeps,
): Effect.Effect<ProbeAuthStatus, ProbeOperationalFailure> {
  if (info.kind === 'claude') {
    return Effect.tryPromise({
      try: () => (deps.claudeAuthProbe ?? probeClaudeAuthStatus)(),
      catch: () => new ProbeOperationalFailure({ reason: 'auth' }),
    })
  }
  // ACP agents advertise `authMethods` whether or not the user is signed in, so it proves nothing.
  return Effect.succeed('unknown')
}

function initializeProbe<R = never>(
  info: HarnessInfo,
  deps: ProbeDeps,
  authenticate: (
    info: HarnessInfo,
    deps: ProbeDeps,
  ) => Effect.Effect<ProbeAuthStatus, ProbeOperationalFailure, R> = authFromInitialize,
): Effect.Effect<ProbeResult, ProbeOperationalFailure, R> {
  const timeoutMs = deps.timeoutMs ?? probeTimeoutFor(info.kind)
  const platform = deps.platform ?? process.platform
  return Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const descriptor = createHarnessSpawn(info, tmpdir(), platform)
          return (deps.spawn ?? defaultSpawn)(descriptor.command, descriptor.args, {
            ...descriptor,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        },
        catch: () => new ProbeOperationalFailure({ reason: 'spawn' }),
      }),
      child =>
        Effect.sync(() => {
          ;(deps.kill ?? ((target, targetPlatform) => killProbeChild(target, targetPlatform, deps.execFile)))(
            child,
            platform,
          )
        }),
    ).pipe(
      Effect.flatMap(child => {
        child.stderr?.resume()
        child.stdin?.on('error', () => {})
        let settled = false
        const childFailure = new Promise<never>((_, reject) => {
          child.on('error', () => reject(new ProbeOperationalFailure({ reason: 'spawn' })))
          child.on('exit', () => {
            if (!settled) reject(new ProbeOperationalFailure({ reason: 'child-exit' }))
          })
        })
        // Late child errors (after success, timeout, or teardown) must never surface as unhandled rejections.
        childFailure.catch(() => {})
        return Effect.try({
          try: () => (deps.connectionFactory ?? defaultConnectionFactory)(child),
          catch: () => new ProbeOperationalFailure({ reason: 'connect' }),
        }).pipe(
          Effect.flatMap(connection =>
            Effect.tryPromise({
              try: () =>
                Promise.race([
                  connection.initialize({
                    protocolVersion: PROTOCOL_VERSION,
                    clientInfo: { name: 'watchtower', version: deps.clientVersion ?? '0.0.0' },
                    clientCapabilities: {},
                  }),
                  childFailure,
                ]),
              catch: error =>
                error instanceof ProbeOperationalFailure ? error : new ProbeOperationalFailure({ reason: 'handshake' }),
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true
                }),
              ),
            ),
          ),
          Effect.flatMap(response =>
            authenticate(info, deps).pipe(
              Effect.map(auth => handshakeResult(info, auth, response.agentInfo?.version ?? undefined)),
            ),
          ),
          Effect.timeoutOption(Duration.millis(timeoutMs)),
          Effect.flatMap(outcome =>
            Option.match(outcome, {
              onNone: () => Effect.fail(new ProbeOperationalFailure({ reason: 'deadline', timeoutMs })),
              onSome: Effect.succeed,
            }),
          ),
        )
      }),
    ),
  )
}

/** Runs ACP initialize and maps expected operational failures to a probe row. */
export function probeHarness(info: HarnessInfo, deps: ProbeDeps = {}): Effect.Effect<ProbeResult, never> {
  return initializeProbe(info, deps).pipe(
    Effect.catchTag('ProbeOperationalFailure', failure => Effect.succeed(errorResult(info, failure))),
  )
}

/** Live main-root path: auth probing stays in the supplied CommandRunner graph. */
export function probeHarnessWithCommandRunner(
  info: HarnessInfo,
  clientVersion: string,
): Effect.Effect<ProbeResult, never, CommandRunner> {
  return initializeProbe(info, { clientVersion }, harness =>
    harness.kind === 'claude' ? runClaudeAuthProbe('claude', ['auth', 'status', '--json']) : Effect.succeed('unknown'),
  ).pipe(Effect.catchTag('ProbeOperationalFailure', failure => Effect.succeed(errorResult(info, failure))))
}
