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

import { probeClaudeAuthStatus } from './auth-probe.js'
import type { HarnessInfo } from './detect.js'
import { harnessSpecs } from './harnesses/index.js'
import { killProcessTree } from './process-tree.js'
import { createHarnessSpawn, type HarnessSpawn } from './runtime.js'

export const HARNESS_PROBE_TIMEOUT_MS = 15_000

export function probeTimeoutFor(kind: string): number {
  return harnessSpecs.find(spec => spec.kind === kind)?.probeTimeoutMs ?? HARNESS_PROBE_TIMEOUT_MS
}

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
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  return new ClientSideConnection(() => client, stream)
}

function killProbeChild(child: ProbeChild, platform: NodeJS.Platform, runExecFile: typeof execFile = execFile): void {
  if (platform === 'win32' && child.pid !== undefined) {
    void killProcessTree(child.pid, platform, runExecFile)
    return
  }
  child.kill('SIGTERM')
}

function errorResult(info: HarnessInfo, detail: string): ProbeResult {
  return {
    status: 'error',
    auth: { status: 'unknown' },
    message: `${info.displayName} ${detail} (${info.bin})`,
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

function authFromInitialize(info: HarnessInfo, deps: ProbeDeps): Effect.Effect<ProbeAuthStatus, unknown> {
  if (info.kind === 'claude') {
    return Effect.tryPromise({
      try: () => (deps.claudeAuthProbe ?? probeClaudeAuthStatus)(),
      catch: error => error,
    })
  }
  // ACP agents advertise `authMethods` whether or not the user is signed in, so it proves nothing.
  return Effect.succeed('unknown')
}

function initializeProbe(info: HarnessInfo, deps: ProbeDeps): Effect.Effect<ProbeResult, unknown> {
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
        catch: error => error,
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
          child.on('error', error => reject(error))
          child.on('exit', (code, signal) => {
            if (!settled) reject(new Error(`ACP child exited before handshake (${code ?? signal ?? 'unknown'})`))
          })
        })
        // Late child errors (after success, timeout, or teardown) must never surface as unhandled rejections.
        childFailure.catch(() => {})
        return Effect.try({
          try: () => (deps.connectionFactory ?? defaultConnectionFactory)(child),
          catch: error => error,
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
              catch: error => error,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true
                }),
              ),
            ),
          ),
          Effect.flatMap(response =>
            authFromInitialize(info, deps).pipe(
              Effect.map(auth => handshakeResult(info, auth, response.agentInfo?.version ?? undefined)),
            ),
          ),
          Effect.timeoutOption(Duration.millis(timeoutMs)),
          Effect.flatMap(outcome =>
            Option.match(outcome, {
              onNone: () => Effect.fail(new Error(`did not answer the ACP handshake within ${timeoutMs / 1000}s`)),
              onSome: Effect.succeed,
            }),
          ),
        )
      }),
    ),
  )
}

/** Runs only ACP initialize and always degrades failures to an honest row. */
export function probeHarness(info: HarnessInfo, deps: ProbeDeps = {}): Effect.Effect<ProbeResult, never> {
  return initializeProbe(info, deps).pipe(
    Effect.catchIf(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the type predicate exhausts the unknown error channel
      (_error): _error is unknown => true,
      error => Effect.succeed(errorResult(info, error instanceof Error ? error.message : String(error))),
    ),
  )
}
