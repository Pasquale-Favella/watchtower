import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { executablePathEnv, which } from '@/infrastructure/agent-harnesses/detect.js'

const validated = Symbol('validated-native-harness-executable')
const MAX_OUTPUT_BYTES = 4_096
const NATIVE_BINARY_SIGNATURES: readonly string[] = [
  '7f454c46',
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]
const versionOutput = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)),
)

export interface ValidatedNativeHarnessExecutable {
  readonly [validated]: true
  readonly instanceId: string
  readonly harnessKind: 'codex'
  readonly driverId: 'codex-app-server'
  readonly displayName: string
  readonly validatedExecutable: string
  readonly version: string
  /** CLI identity evidence only: authentication and runtime capabilities remain unknown. */
  readonly validation: {
    readonly kind: 'version'
    readonly args: readonly ['--version']
    readonly stdout: string
    readonly exitCode: 0
  }
}

/** The SDK chooses its bundled CLI; finding `claude` on PATH proves neither distribution nor auth permission. */
export const claudeNativeAvailability = Object.freeze({
  driverId: 'claude-agent-sdk',
  availability: 'release-gated',
  distribution: 'bundled-sdk-cli',
  requiresHostExecutable: false,
  reason: 'Authorized authentication and distribution remain unverified; see agent-driver-conformance.md.',
} as const)

export interface NativeExecutableDiscoveryOptions {
  readonly platform?: NodeJS.Platform
  readonly pathEnv?: string
  /** Filesystem/PATH boundary overrides for deterministic tests, never a launch command. */
  readonly commandExists?: (command: string) => string | null
  readonly resolveNativeExecutable?: (path: string) => string | undefined
  readonly timeoutMs?: number
}

function absolutePath(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(path)
    : posix.isAbsolute(path)
}

/** Follow symlinks, then accept binary headers only, not extensionless npm/shell launchers. */
function resolveNativeExecutable(path: string): string | undefined {
  const resolved = realpathSync(path)
  if (!statSync(resolved).isFile()) return undefined
  const fd = openSync(resolved, 'r')
  try {
    const header = Buffer.alloc(4)
    if (readSync(fd, header, 0, 4, 0) !== 4) return undefined
    const magic = header.toString('hex')
    return magic.startsWith('4d5a') || NATIVE_BINARY_SIGNATURES.includes(magic) ? resolved : undefined
  } finally {
    closeSync(fd)
  }
}

export function isValidatedNativeHarnessExecutable(value: ValidatedNativeHarnessExecutable): boolean {
  return value[validated] === true
}

const probeExecutable = Effect.fnUntraced(function* (
  executable: string,
  timeoutMs: number,
): Effect.fn.Return<ValidatedNativeHarnessExecutable | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ['--version'], {
          shell: false,
          windowsHide: true,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          additionalFds: {},
          forceKillAfter: Duration.millis(250),
        }),
      )
      let totalBytes = 0
      const stdout: Uint8Array[] = []
      const collect = (stream: typeof child.stdout, capture: boolean) =>
        Stream.runForEach(stream, chunk => {
          totalBytes += chunk.byteLength
          if (totalBytes > MAX_OUTPUT_BYTES) return Effect.fail('output-limit' as const)
          if (capture && chunk.byteLength > 0) stdout.push(chunk)
          return Effect.void
        })
      const [, , exitCode] = yield* Effect.all(
        [collect(child.stdout, true), collect(child.stderr, false), child.exitCode],
        { concurrency: 'unbounded' },
      )
      if (Number(exitCode) !== 0) return yield* Effect.fail('non-zero-exit' as const)
      const output = yield* Schema.decodeUnknownEffect(versionOutput)(Buffer.concat(stdout).toString('utf8').trim())
      return Object.freeze({
        [validated]: true as const,
        instanceId: 'codex:path',
        harnessKind: 'codex' as const,
        driverId: 'codex-app-server' as const,
        displayName: 'Codex (native)',
        validatedExecutable: executable,
        version: output.slice('codex-cli '.length),
        validation: Object.freeze({
          kind: 'version' as const,
          args: Object.freeze(['--version'] as const),
          stdout: output,
          exitCode: 0 as const,
        }),
      })
    }),
  ).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  )
})

/** Discover the first validated native PATH slot. No prompt, auth probe or SDK loading occurs. */
export const discoverNativeHarnessExecutables = Effect.fn('discoverNativeHarnessExecutables')(function* (
  options: NativeExecutableDiscoveryOptions = {},
): Effect.fn.Return<ReadonlyArray<ValidatedNativeHarnessExecutable>, never, ChildProcessSpawner.ChildProcessSpawner> {
  const platform = options.platform ?? process.platform
  const command = 'codex'
  const candidates = yield* Effect.try(() => {
    if (options.commandExists) return [options.commandExists(command)]
    const separator = platform === 'win32' ? ';' : ':'
    return (options.pathEnv ?? executablePathEnv())
      .split(separator)
      .filter(dir => absolutePath(dir, platform))
      .map(dir => which(command, dir, platform))
  }).pipe(Effect.catch(() => Effect.succeed([])))
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || !absolutePath(candidate, platform)) continue
    const executable = yield* Effect.try(() =>
      (options.resolveNativeExecutable ?? resolveNativeExecutable)(candidate),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!executable || !absolutePath(executable, platform) || seen.has(executable)) continue
    if (
      platform === 'win32'
        ? !executable.toLowerCase().endsWith('.exe')
        : /\.(?:cmd|bat|ps1|sh|js|mjs|cjs)$/i.test(executable)
    )
      continue
    seen.add(executable)
    const result = yield* probeExecutable(executable, options.timeoutMs ?? 3_000)
    if (result) return [result]
  }
  return []
})
