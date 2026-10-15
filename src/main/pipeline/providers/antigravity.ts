import type { Stats } from 'node:fs'

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { Effect, Result, Schema, Stream } from 'effect'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises'
import https from 'https'
import { homedir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'

import { parsedProviderCallSchema } from '../../../shared/schemas/providers.js'
import { resolveCacheDir } from '../../env.js'
import { billableOutputTokens } from '../billable-output.js'
import { readSessionLinesStream, SessionLineReadError } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError, ScanAbortedError, scanAbortError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { SqliteDatabase } from '../sqlite.js'
import { blobToText, isSqliteAvailable, isSqliteBusyError, openDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

type AntigravityConversationRoot = {
  dir: string
  project: string
  extensions: readonly string[]
}

class ProviderOperationError extends Schema.TaggedError<ProviderOperationError>()('ProviderOperationError', {
  operation: Schema.Literals(['readdir', 'stat']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

// Computed on each call rather than frozen at module load so discovery honors
// the current home directory (env overrides in tests, and any runtime change).
function conversationRoots(): readonly AntigravityConversationRoot[] {
  const home = homedir()
  return [
    {
      dir: join(home, '.gemini', 'antigravity', 'conversations'),
      project: 'antigravity',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'conversations'),
      project: 'antigravity-cli',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'implicit'),
      project: 'antigravity-cli',
      extensions: ['.pb'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'conversations'),
      project: 'antigravity-ide',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'implicit'),
      project: 'antigravity-ide',
      extensions: ['.pb'],
    },
  ]
}
const CACHE_VERSION = 5

const RPC_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type ServerInfo = {
  port: number
  csrfToken: string
}

type ServerCandidate = ServerInfo & {
  appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide'
}

type ModelMap = Record<string, string>

type UsageEntry = {
  model: string
  inputTokens: string
  outputTokens: string
  thinkingOutputTokens?: string
  responseOutputTokens?: string
  apiProvider: string
  responseId?: string
}

export type GeneratorMetadata = {
  stepIndices?: number[]
  chatModel?: {
    model: string
    usage: UsageEntry
    chatStartMetadata?: {
      createdAt?: string
    }
  }
}

type ModelMapResponse = {
  models?: Record<string, { model?: string; displayName?: string }>
  response?: {
    models?: Record<string, { model?: string; displayName?: string }>
  }
}

type GeneratorMetadataResponse = {
  generatorMetadata?: GeneratorMetadata[]
  response?: {
    generatorMetadata?: GeneratorMetadata[]
  }
}

type StatusLineEvent = {
  at: string
  conversationId: string
  sessionId?: string
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }
}

const statusLineEventInputSchema = Schema.Struct({
  at: Schema.optional(Schema.Unknown),
  conversationId: Schema.optional(Schema.Unknown),
  sessionId: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(Schema.Unknown),
      outputTokens: Schema.optional(Schema.Unknown),
      cacheCreationInputTokens: Schema.optional(Schema.Unknown),
      cacheReadInputTokens: Schema.optional(Schema.Unknown),
    }),
  ),
})
const decodeStatusLineEventInput = Schema.decodeUnknownResult(statusLineEventInputSchema)
const decodeStatusLineJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

type StatusLineRun = { event: StatusLineEvent; signature: string; count: number }
type StatusLineRunsByConversation = Map<string, StatusLineRun[]>

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const cachedCascadeSchema = Schema.Struct({
  mtimeMs: finiteNumber,
  sizeBytes: finiteNumber,
  calls: Schema.mutable(Schema.Array(parsedProviderCallSchema)),
})
const antigravityCacheSchema = Schema.Struct({
  version: Schema.Literal(CACHE_VERSION),
  cascades: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(cachedCascadeSchema))),
})
const antigravityCacheJsonSchema = Schema.fromJsonString(antigravityCacheSchema)
type AntigravityCache = typeof antigravityCacheSchema.Type

type ProtoField = {
  number: number
  wireType: number
  value?: bigint
  bytes?: Uint8Array
}

type ProtoVarint = {
  value: bigint
  offset: number
}

type AntigravityGenMetadataRow = {
  idx: unknown
  data: Uint8Array | string
}

type AntigravityCallCandidate = Omit<ParsedProviderCall, 'costUSD'> & { pricingModel: string }

const genMetadataRowSchema = Schema.Struct({
  idx: Schema.Unknown,
  data: Schema.Union([Schema.Uint8Array, Schema.String]),
})
const decodeGenMetadataRow = Schema.decodeUnknownResult(genMetadataRowSchema)

const cachedServers = new Map<string, ServerInfo | null>()
const cachedModelMaps = new Map<string, ModelMap>()
let memCache: AntigravityCache | null = null
let cacheDirty = false
let httpsAgent: https.Agent | undefined
const protoTextDecoder = new TextDecoder('utf-8', { fatal: false })

const SERVER_PORT_FLAGS = ['https_server_port', 'extension_server_port', 'https-server-port', 'extension-server-port']
const CSRF_TOKEN_FLAGS = ['csrf_token', 'extension_server_csrf_token', 'csrf-token', 'extension-server-csrf-token']
const APP_DATA_DIR_FLAGS = ['app_data_dir', 'app-data-dir']

function getAgent(): https.Agent {
  if (!httpsAgent) httpsAgent = new https.Agent({ rejectUnauthorized: false })
  return httpsAgent
}

function getCacheDir(): string {
  return resolveCacheDir()
}

function getCachePath(): string {
  return join(getCacheDir(), 'antigravity-results.json')
}

export function getAntigravityStatusLineEventsPath(): string {
  return join(getCacheDir(), 'antigravity-statusline.jsonl')
}

class AntigravityProcessError extends Schema.TaggedError<AntigravityProcessError>()('AntigravityProcessError', {
  command: Schema.String,
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

class AntigravityRpcError extends Schema.TaggedError<AntigravityRpcError>()('AntigravityRpcError', {
  method: Schema.String,
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

const execFileTextEffect = Effect.fnUntraced(function* (
  command: string,
  args: string[],
  timeout = 3000,
  signal?: AbortSignal,
): Effect.fn.Return<string, Error | AntigravityProcessError | ScanAbortedError> {
  yield* checkScanAbort(signal)
  const output = yield* Effect.callback<string, AntigravityProcessError | ScanAbortedError>(resume => {
    let child: ReturnType<typeof execFile> | undefined
    let closed = false
    let completed = false
    const finish = (effect: Effect.Effect<string, AntigravityProcessError | ScanAbortedError>): void => {
      if (completed) return
      completed = true
      signal?.removeEventListener('abort', abort)
      resume(effect)
    }
    const abort = (): void => {
      child?.kill()
    }
    try {
      child = execFile(command, args, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (signal?.aborted) {
          finish(Effect.fail(scanAbortError(signal)))
        } else if (err) {
          finish(
            Effect.fail(
              new AntigravityProcessError({
                command,
                cause: err,
                message: 'Antigravity process inspection failed',
              }),
            ),
          )
        } else {
          finish(Effect.succeed(stdout))
        }
      })
    } catch (cause) {
      finish(
        Effect.fail(
          new AntigravityProcessError({
            command,
            cause,
            message: 'Antigravity process inspection failed',
          }),
        ),
      )
    }

    if (child && !completed) {
      child.once('close', () => {
        closed = true
        if (signal?.aborted) finish(Effect.fail(scanAbortError(signal)))
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    }

    return Effect.gen(function* () {
      signal?.removeEventListener('abort', abort)
      const activeChild = child
      if (!activeChild || completed) return
      activeChild.kill()
      if (!closed) {
        yield* Effect.promise(() => new Promise<void>(resolve => activeChild.once('close', () => resolve())))
      }
    })
  })
  yield* checkScanAbort(signal)
  return output
})

function getFlagValue(line: string, names: string[]): string | null {
  for (const name of names) {
    const match = line.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i'))
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value && !value.startsWith('--')) return value
  }
  return null
}

function isLikelyCsrfToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~:/+=-]+$/.test(value)
}

function normalizeAppDataDir(value: string | null): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('antigravity-ide')) return 'antigravity-ide'
  if (normalized.includes('antigravity-cli')) return 'antigravity-cli'
  if (normalized.includes('antigravity')) return 'antigravity'
  return undefined
}

export function extractAntigravityAppDataDirFromLine(
  line: string,
): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  return normalizeAppDataDir(getFlagValue(line, APP_DATA_DIR_FLAGS))
}

function parseAntigravityServerCandidateFromLine(line: string): ServerCandidate | null {
  const lower = line.toLowerCase()
  if (!lower.includes('language_server') || !lower.includes('antigravity')) return null

  const rawPort = getFlagValue(line, SERVER_PORT_FLAGS)
  const csrfToken = getFlagValue(line, CSRF_TOKEN_FLAGS)
  if (!rawPort || !csrfToken) return null
  if (!isLikelyCsrfToken(csrfToken)) return null

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null

  return {
    port,
    csrfToken,
    appDataDir: extractAntigravityAppDataDirFromLine(line),
  }
}

export function parseAntigravityServerInfoFromLine(line: string): ServerInfo | { port: 0; csrfToken: string } | null {
  const candidate = parseAntigravityServerCandidateFromLine(line)
  return candidate ? { port: candidate.port, csrfToken: candidate.csrfToken } : null
}

export function parseAntigravityServerInfo(lines: string[]): ServerInfo | null {
  for (const line of lines) {
    const server = parseAntigravityServerInfoFromLine(line)
    if (server) return server
  }
  return null
}

function parseAntigravityServerCandidates(lines: string[]): ServerCandidate[] {
  return lines
    .map(parseAntigravityServerCandidateFromLine)
    .filter((server): server is ServerCandidate => server !== null)
}

// Antigravity's own model-map config sometimes hasn't caught up with a new
// model yet, so both the config key and displayName can still be the raw
// placeholder id (e.g. "MODEL_PLACEHOLDER_M26"). Falling through to that
// value as the "canonical" model would leak an internal placeholder as a
// model name; 'unknown' is what this file already uses when no model can be
// resolved at all (see antigravitySqliteModel).
const MODEL_PLACEHOLDER_PATTERN = /^MODEL_PLACEHOLDER_/

function dropPlaceholderModelId(model: string): string {
  return MODEL_PLACEHOLDER_PATTERN.test(model) ? 'unknown' : model
}

function getCanonicalModelId(key: string, displayName?: string): string {
  if (displayName) {
    const lower = displayName.toLowerCase()
    if (lower.includes('3.5 flash')) {
      if (lower.includes('high')) return 'gemini-3.5-flash-high'
      if (lower.includes('medium')) return 'gemini-3.5-flash-medium'
      if (lower.includes('low')) return 'gemini-3.5-flash-low'
      return 'gemini-3.5-flash'
    }
    if (lower.includes('3.1 pro')) {
      if (lower.includes('high')) return 'gemini-3.1-pro-high'
      if (lower.includes('low')) return 'gemini-3.1-pro-low'
      return 'gemini-3.1-pro'
    }
    if (lower.includes('3.1 flash')) {
      if (lower.includes('image')) return 'gemini-3.1-flash-image'
      if (lower.includes('lite')) return 'gemini-3.1-flash-lite'
      return 'gemini-3.1-flash'
    }
    if (lower.includes('3 flash')) {
      return 'gemini-3-flash'
    }
    if (lower.includes('3 pro')) {
      return 'gemini-3-pro'
    }
  }
  return dropPlaceholderModelId(key)
}

export function extractAntigravityModelMap(resp: unknown): ModelMap {
  if (!resp || typeof resp !== 'object') return {}
  const data = resp as ModelMapResponse
  const models = data.response?.models ?? data.models
  const map = new Map<string, string>()
  if (!models) return {}
  for (const [key, info] of Object.entries(models)) {
    if (info && typeof info === 'object' && typeof info.model === 'string') {
      const canonicalKey = getCanonicalModelId(key, info.displayName)
      map.set(info.model, canonicalKey)
    }
  }
  return Object.fromEntries(map)
}

export function extractAntigravityGeneratorMetadata(resp: unknown): GeneratorMetadata[] {
  if (!resp || typeof resp !== 'object') return []
  const data = resp as GeneratorMetadataResponse
  const metadata = data.response?.generatorMetadata ?? data.generatorMetadata
  return Array.isArray(metadata) ? metadata : []
}

class AntigravityCacheIoError extends Schema.TaggedError<AntigravityCacheIoError>()('AntigravityCacheIoError', {
  operation: Schema.Literals(['read', 'mkdir', 'open', 'write', 'sync', 'close', 'rename', 'unlink']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

type CacheIoOperation = 'read' | 'mkdir' | 'open' | 'write' | 'sync' | 'close' | 'rename' | 'unlink'

const checkCacheAbort = Effect.fnUntraced(function* (signal?: AbortSignal): Effect.fn.Return<void, ScanAbortedError> {
  if (signal?.aborted) return yield* Effect.fail(scanAbortError(signal))
})

const cacheIo = Effect.fnUntraced(function* <A>(
  operation: CacheIoOperation,
  run: () => Promise<A>,
): Effect.fn.Return<A, AntigravityCacheIoError> {
  return yield* scanIo(run).pipe(
    Effect.mapError(
      cause => new AntigravityCacheIoError({ operation, cause, message: `Antigravity cache ${operation} failed` }),
    ),
  )
})

const loadCacheEffect = Effect.fnUntraced(function* (signal?: AbortSignal): Effect.fn.Return<AntigravityCache, Error> {
  yield* checkCacheAbort(signal)
  if (memCache) return memCache

  const raw = yield* cacheIo('read', () => readFile(getCachePath(), 'utf-8')).pipe(
    Effect.catchTag('AntigravityCacheIoError', () => Effect.succeed(null)),
  )
  yield* checkCacheAbort(signal)
  const decoded =
    raw === null
      ? null
      : yield* Schema.decodeUnknownEffect(antigravityCacheJsonSchema)(raw).pipe(
          Effect.matchEffect({ onFailure: () => Effect.succeed(null), onSuccess: Effect.succeed }),
        )
  yield* checkCacheAbort(signal)
  memCache = decoded ?? { version: CACHE_VERSION, cascades: {} }
  return memCache
})

export const flushAntigravityCacheEffect = Effect.fn('flushAntigravityCacheEffect')(function* (
  liveCascadeIds?: Set<string>,
  signal?: AbortSignal,
): Effect.fn.Return<void, AntigravityCacheIoError | ScanAbortedError | Schema.SchemaError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* checkCacheAbort(signal)
      if (!memCache) return
      // If the caller supplied liveCascadeIds, we must run the eviction step
      // even when no cascade was added or updated this run; otherwise deleted
      // .pb files would persist in the cache forever once it stops getting
      // dirty writes. Mark the cache dirty when an eviction happens so the
      // file write below proceeds.
      if (liveCascadeIds) {
        for (const id of Object.keys(memCache.cascades)) {
          if (!liveCascadeIds.has(id)) {
            delete memCache.cascades[id]
            cacheDirty = true
          }
        }
      }
      if (!cacheDirty) return

      const dir = getCacheDir()
      yield* checkCacheAbort(signal)
      yield* cacheIo('mkdir', () => mkdir(dir, { recursive: true }))
      yield* checkCacheAbort(signal)
      const finalPath = getCachePath()
      const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
      let ownedTempPath: string | undefined = tempPath
      yield* Effect.addFinalizer(() => {
        if (!ownedTempPath) return Effect.void
        const path = ownedTempPath
        ownedTempPath = undefined
        return cacheIo('unlink', () => unlink(path)).pipe(Effect.catchTag('AntigravityCacheIoError', () => Effect.void))
      })

      // Invalid in-memory data is a schema failure, not a recoverable filesystem
      // outcome. Let it escape after the scoped temp cleanup and keep dirty set.
      const encoded = yield* Schema.encodeUnknownEffect(antigravityCacheSchema)(memCache)
      const payload = JSON.stringify(encoded)
      yield* checkCacheAbort(signal)

      const file = yield* Effect.acquireRelease(
        Effect.uninterruptible(
          cacheIo('open', () => open(tempPath, 'w', 0o600)).pipe(Effect.map(handle => ({ handle, closed: false }))),
        ),
        owned => {
          if (owned.closed) return Effect.void
          owned.closed = true
          return cacheIo('close', () => owned.handle.close()).pipe(
            Effect.catchTag('AntigravityCacheIoError', () => Effect.void),
          )
        },
      )

      yield* checkCacheAbort(signal)
      yield* cacheIo('write', () => file.handle.writeFile(payload, { encoding: 'utf-8' }))
      yield* checkCacheAbort(signal)
      yield* cacheIo('sync', () => file.handle.sync())
      yield* checkCacheAbort(signal)
      file.closed = true
      yield* cacheIo('close', () => file.handle.close())
      yield* checkCacheAbort(signal)

      // Check cancellation before beginning the commit attempt. The leaf itself
      // drains uninterruptibly, then dirty-state follows whether rename worked.
      yield* checkCacheAbort(signal)
      yield* Effect.uninterruptible(
        cacheIo('rename', () => rename(tempPath, finalPath)).pipe(
          Effect.map(() => true),
          Effect.catchTag('AntigravityCacheIoError', () => Effect.succeed(false)),
          Effect.tap(renamed =>
            Effect.sync(() => {
              if (renamed) ownedTempPath = undefined
              // Match the previous attempt policy: a completed rename attempt
              // clears dirty even on rejected rename. Earlier failures stay dirty.
              cacheDirty = false
            }),
          ),
        ),
      )
      yield* checkCacheAbort(signal)
    }),
  ).pipe(Effect.catchTag('AntigravityCacheIoError', () => Effect.void))
})

async function flushCache(liveCascadeIds?: Set<string>): Promise<void> {
  // Remove this Promise edge once the remaining Antigravity cache writers use the native cache effect.
  // eslint-disable-next-line no-restricted-syntax
  await Effect.runPromise(flushAntigravityCacheEffect(liveCascadeIds))
}

const readProcessCommandLinesEffect = Effect.fnUntraced(function* (
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error | AntigravityProcessError | ScanAbortedError> {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { $_.CommandLine }",
    ].join('; ')
    const output = yield* execFileTextEffect(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      5000,
      signal,
    )
    return output.split(/\r?\n/)
  }

  const output = yield* execFileTextEffect('ps', ['-ww', '-eo', 'args'], 3000, signal)
  return output.split('\n')
})

const resolveEphemeralPortEffect = Effect.fnUntraced(function* (
  csrfToken: string,
  appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide',
  signal?: AbortSignal,
): Effect.fn.Return<ServerInfo | null, Error | AntigravityProcessError | AntigravityRpcError | ScanAbortedError> {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { @{ PID = $_.ProcessId; Cmd = $_.CommandLine } | ConvertTo-Json -Compress }",
    ].join('; ')
    const output = yield* execFileTextEffect(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      5000,
      signal,
    ).pipe(Effect.catchTag('AntigravityProcessError', () => Effect.succeed('')))

    let targetPid = 0
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const proc = JSON.parse(line) as { PID: number; Cmd: string }
        const candidate = parseAntigravityServerCandidateFromLine(proc.Cmd)
        if (candidate && candidate.csrfToken === csrfToken) {
          if (!appDataDir || !candidate.appDataDir || candidate.appDataDir === appDataDir) {
            targetPid = proc.PID
            break
          }
        }
      } catch {
        /* skip invalid parse */
      }
    }

    if (targetPid === 0) return null

    const portScript = `Get-NetTCPConnection -State Listen -OwningProcess ${targetPid} | Select-Object -ExpandProperty LocalPort`
    const portOutput = yield* execFileTextEffect(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', portScript],
      5000,
      signal,
    ).pipe(Effect.catchTag('AntigravityProcessError', () => Effect.succeed('')))
    const ports = portOutput
      .split(/\r?\n/)
      .map(p => Number(p.trim()))
      .filter(p => Number.isInteger(p) && p > 0)

    for (const port of ports) {
      const probe = yield* probePortEffect({ port, csrfToken }, signal).pipe(
        Effect.catchTag('AntigravityRpcError', () => Effect.succeed(false)),
      )
      if (probe) return { port, csrfToken }
    }
    return null
  }

  const processOutput = yield* execFileTextEffect('ps', ['-ww', '-eo', 'pid=,args='], 3000, signal).pipe(
    Effect.catchTag('AntigravityProcessError', () => Effect.succeed('')),
  )
  let pid = ''
  for (const line of processOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const candidate = parseAntigravityServerCandidateFromLine(match[2]!)
    if (!candidate) continue
    if (candidate.csrfToken !== csrfToken) continue
    if (appDataDir && candidate.appDataDir && candidate.appDataDir !== appDataDir) continue
    pid = match[1]!
    break
  }
  if (!pid) return null

  const lsofOutput = yield* execFileTextEffect('lsof', ['-a', '-i', '-P', '-n', '-p', pid], 3000, signal).pipe(
    Effect.catchTag('AntigravityProcessError', () => Effect.succeed('')),
  )
  for (const line of lsofOutput.split('\n')) {
    if (!line.includes('LISTEN')) continue
    const match = line.match(/:(\d+)\s+\(LISTEN\)/)
    if (!match) continue
    const port = Number(match[1])
    if (port > 0) return { port, csrfToken }
  }
  return null
})

const detectServerEffect = Effect.fnUntraced(function* (
  appDataDir: 'antigravity' | 'antigravity-cli' | 'antigravity-ide' = 'antigravity',
  signal?: AbortSignal,
): Effect.fn.Return<ServerInfo | null, Error | AntigravityProcessError | AntigravityRpcError | ScanAbortedError> {
  yield* checkScanAbort(signal)
  if (cachedServers.has(appDataDir)) return cachedServers.get(appDataDir)!
  const candidates = yield* readProcessCommandLinesEffect(signal).pipe(
    Effect.catchTag('AntigravityProcessError', () => Effect.succeed([])),
  )
  const parsedCandidates = parseAntigravityServerCandidates(candidates)
  const info =
    parsedCandidates.find(candidate => candidate.appDataDir === appDataDir) ??
    (appDataDir === 'antigravity'
      ? parsedCandidates.find(candidate => candidate.appDataDir === undefined)
      : undefined) ??
    null
  let detected: ServerInfo | null = null
  if (info && info.port > 0 && appDataDir !== 'antigravity-ide') {
    detected = { port: info.port, csrfToken: info.csrfToken }
  } else if (info) {
    detected = yield* resolveEphemeralPortEffect(info.csrfToken, appDataDir, signal)
  }
  cachedServers.set(appDataDir, detected)
  return detected
})

const rpcEffect = Effect.fnUntraced(function* (
  server: ServerInfo,
  method: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Effect.fn.Return<unknown, Error | AntigravityRpcError | ScanAbortedError> {
  yield* checkScanAbort(signal)
  const data = JSON.stringify(body)
  const response = yield* requestJsonEffect(server, method, data, RPC_TIMEOUT_MS, MAX_RESPONSE_BYTES, true, signal)
  yield* checkScanAbort(signal)
  return response
})

const getModelMapEffect = Effect.fnUntraced(function* (
  server: ServerInfo,
  signal?: AbortSignal,
): Effect.fn.Return<ModelMap, Error | AntigravityRpcError | ScanAbortedError> {
  yield* checkScanAbort(signal)
  const cacheKey = `${server.port}:${server.csrfToken}`
  const cachedModelMap = cachedModelMaps.get(cacheKey)
  if (cachedModelMap) return cachedModelMap
  const modelMap = yield* rpcEffect(server, 'GetAvailableModels', {}, signal).pipe(
    Effect.map(extractAntigravityModelMap),
    Effect.catchTag('AntigravityRpcError', () => Effect.succeed({})),
  )
  cachedModelMaps.set(cacheKey, modelMap)
  return modelMap
})

function requestJsonEffect(
  server: ServerInfo,
  method: string,
  data: string,
  timeout: number,
  maxResponseBytes: number | undefined,
  decodeJson: boolean,
  signal?: AbortSignal,
): Effect.Effect<unknown, Error | AntigravityRpcError | ScanAbortedError> {
  return Effect.callback<unknown, Error | AntigravityRpcError | ScanAbortedError>(resume => {
    let request: ReturnType<typeof https.request> | undefined
    let response: import('http').IncomingMessage | undefined
    let closed = false
    let settled = false
    let pendingFailure: Error | ScanAbortedError | undefined
    const settle = (effect: Effect.Effect<unknown, AntigravityRpcError | ScanAbortedError>): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resume(effect)
    }
    const settleFailure = (cause: unknown): void => {
      const failure = signal?.aborted ? scanAbortError(signal) : cause instanceof ScanAbortedError ? cause : undefined
      settle(
        Effect.fail(
          failure ??
            new AntigravityRpcError({
              method,
              cause,
              message: `Antigravity RPC ${method} failed`,
            }),
        ),
      )
    }
    const settleSuccess = (value: unknown): void => {
      settle(Effect.succeed(value))
    }
    const failAndClose = (cause: Error | ScanAbortedError): void => {
      if (settled || pendingFailure) return
      pendingFailure = cause
      if (response && !response.destroyed) response.destroy()
      if (request && !request.destroyed) request.destroy()
      if (!request || closed) settleFailure(cause)
    }
    const abort = (): void => {
      if (signal) failAndClose(scanAbortError(signal))
    }
    const onClose = (): void => {
      closed = true
      if (pendingFailure) settleFailure(pendingFailure)
      else if (!decodeJson && response?.statusCode === 200) settleSuccess(undefined)
    }

    if (signal?.aborted) {
      settleFailure(scanAbortError(signal))
      return
    }

    try {
      request = https.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `/exa.language_server_pb.LanguageServerService/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': server.csrfToken,
            'Content-Length': Buffer.byteLength(data),
          },
          agent: getAgent(),
          timeout,
        },
        res => {
          response = res
          res.on('error', failAndClose)
          if (!decodeJson) {
            if (res.statusCode !== 200) {
              failAndClose(new Error(`RPC ${method}: HTTP ${res.statusCode}`))
            } else {
              res.destroy()
              request?.destroy()
            }
            return
          }
          const chunks: Buffer[] = []
          let totalBytes = 0
          res.on('data', chunk => {
            if (settled || pendingFailure) return
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalBytes += bytes.length
            if (maxResponseBytes !== undefined && totalBytes > maxResponseBytes) {
              failAndClose(new Error(`RPC ${method}: response too large`))
              return
            }
            chunks.push(bytes)
          })
          res.on('end', () => {
            if (settled || pendingFailure) return
            if (res.statusCode !== 200) {
              failAndClose(new Error(`RPC ${method}: HTTP ${res.statusCode}`))
              return
            }
            try {
              settleSuccess(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
            } catch (cause) {
              failAndClose(new Error(`RPC ${method}: invalid JSON`, { cause }))
            }
          })
          res.on('aborted', () => failAndClose(new Error(`RPC ${method}: response aborted`)))
        },
      )
      request.once('close', onClose)
      request.on('error', failAndClose)
      request.on('timeout', () => failAndClose(new Error(`RPC ${method}: timeout`)))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      request.write(data)
      request.end()
    } catch (cause) {
      failAndClose(toError(cause))
    }

    return Effect.gen(function* () {
      signal?.removeEventListener('abort', abort)
      const activeRequest = request
      if (!activeRequest || settled) return
      if (!activeRequest.destroyed) activeRequest.destroy()
      if (response && !response.destroyed) response.destroy()
      if (!closed)
        yield* Effect.promise(() => new Promise<void>(resolve => activeRequest.once('close', () => resolve())))
    })
  })
}

const probePortEffect = Effect.fnUntraced(function* (
  server: ServerInfo,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error | AntigravityRpcError | ScanAbortedError> {
  yield* requestJsonEffect(server, 'GetAvailableModels', '{}', 1000, undefined, false, signal)
  return true
})

export function antigravityAppDataDirFromSourcePath(
  path: string,
): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' {
  const lower = path.replace(/\\/g, '/').toLowerCase()
  if (lower.includes('/.gemini/antigravity-ide/')) return 'antigravity-ide'
  if (lower.includes('/.gemini/antigravity-cli/')) return 'antigravity-cli'
  return 'antigravity'
}

// Strip Antigravity-specific suffixes so the pricing DB can match
const PRICING_ALIASES: Record<string, string> = {
  'gemini-pro': 'gemini-3.1-pro',
}

function normalizePricingModel(model: string): string {
  const stripped = model.replace(/-(high|medium|low|agent)$/, '')
  return PRICING_ALIASES[stripped] ?? stripped
}

function readProtoVarint(data: Uint8Array, startOffset: number): ProtoVarint | null {
  let value = 0n
  let shift = 0n
  let offset = startOffset

  while (offset < data.length) {
    const byte = BigInt(data[offset]!)
    offset += 1
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, offset }
    shift += 7n
    if (shift > 70n) return null
  }

  return null
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0

  while (offset < data.length) {
    const key = readProtoVarint(data, offset)
    if (!key) break
    offset = key.offset

    const fieldNumber = Number(key.value >> 3n)
    const wireType = Number(key.value & 0x7n)
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break

    if (wireType === 0) {
      const value = readProtoVarint(data, offset)
      if (!value) break
      fields.push({ number: fieldNumber, wireType, value: value.value })
      offset = value.offset
      continue
    }

    if (wireType === 1) {
      if (offset + 8 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) })
      offset += 8
      continue
    }

    if (wireType === 2) {
      const length = readProtoVarint(data, offset)
      if (!length) break
      offset = length.offset
      const byteLength = Number(length.value)
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) })
      offset += byteLength
      continue
    }

    if (wireType === 5) {
      if (offset + 4 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) })
      offset += 4
      continue
    }

    break
  }

  return fields
}

function firstProtoField(fields: readonly ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find(field => field.number === fieldNumber)
}

function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (!field?.bytes || field.bytes.length === 0) return undefined
  const text = protoTextDecoder.decode(field.bytes)
  if (!text || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) return undefined
  return text
}

function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) return 0
  const value = Number(field.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes
}

function isAntigravityResponseId(value: string): boolean {
  return /^[^\s]+$/.test(value)
}

function antigravitySqliteResponseId(usageFields: readonly ProtoField[], fallback: string): string {
  const responseId = protoFieldText(firstProtoField(usageFields, 11))
  return responseId && isAntigravityResponseId(responseId) ? responseId : fallback
}

function genMetadataDataBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function antigravitySqliteMetadataAttributes(chatFields: readonly ProtoField[]): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const field of chatFields) {
    if (field.number !== 20) continue
    const pairFields = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array())
    const key = protoFieldText(firstProtoField(pairFields, 1))
    const value = protoFieldText(firstProtoField(pairFields, 2))
    if (key && value) attributes.set(key, value)
  }
  return attributes
}

function antigravitySqliteModel(chatFields: readonly ProtoField[]): string {
  const attributes = antigravitySqliteMetadataAttributes(chatFields)
  const displayName = protoFieldText(firstProtoField(chatFields, 21))
  const rawModel =
    protoFieldText(firstProtoField(chatFields, 19)) ?? attributes.get('model_enum') ?? displayName ?? 'unknown'

  return getCanonicalModelId(rawModel, displayName)
}

// Decode a proto field that carries a time into an ISO-8601 string. Antigravity
// may encode ChatStartMetadata.created_at as an ISO string, a Timestamp
// submessage (seconds in field 1), or a bare unix varint. Returns '' when the
// field is absent or unparseable so the caller can fall back.
function protoTimestampToIso(field: ProtoField | undefined): string {
  if (!field) return ''
  const text = protoFieldText(field)
  if (text && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString()
  if (field.bytes) {
    // google.protobuf.Timestamp submessage: seconds (#1), nanos (#2).
    const tsFields = parseProtoFields(field.bytes)
    const seconds = firstProtoField(tsFields, 1)?.value
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n
      const ms = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6)
      if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
    }
  }
  if (field.value !== undefined) {
    const raw = Number(field.value)
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
  }
  return ''
}

// ChatStartMetadata lives at chatModel(#1).#9; its created_at is #4. Not every
// gen_metadata row carries it, so this returns '' when missing.
function antigravitySqliteCreatedAt(chatFields: readonly ProtoField[]): string {
  const metadataBytes = protoFieldBytes(firstProtoField(chatFields, 9))
  if (!metadataBytes) return ''
  return protoTimestampToIso(firstProtoField(parseProtoFields(metadataBytes), 4))
}

function buildCandidateFromSqliteGenMetadataRow(
  cascadeId: string,
  row: AntigravityGenMetadataRow,
): AntigravityCallCandidate | null {
  const rootFields = parseProtoFields(genMetadataDataBytes(row.data))
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array())
  const usageFields = parseProtoFields(protoFieldBytes(firstProtoField(chatFields, 4)) ?? new Uint8Array())
  if (usageFields.length === 0) return null

  const inputTokens =
    protoFieldPositiveInteger(firstProtoField(usageFields, 2)) ||
    protoFieldPositiveInteger(firstProtoField(usageFields, 1))
  const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3))
  let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9))
  const thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10))

  if (responseTokens === 0 && thinkingTokens === 0) {
    responseTokens = totalOutputTokens
  } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
    const adjustedResponseTokens = totalOutputTokens - thinkingTokens
    if (adjustedResponseTokens >= 0) responseTokens = adjustedResponseTokens
  }

  if (inputTokens === 0 && totalOutputTokens === 0) return null

  const responseId = antigravitySqliteResponseId(usageFields, String(row.idx))
  const model = antigravitySqliteModel(chatFields)

  return {
    provider: 'antigravity',
    model,
    inputTokens,
    outputTokens: responseTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: thinkingTokens,
    webSearchRequests: 0,
    tools: [],
    bashCommands: [],
    timestamp: antigravitySqliteCreatedAt(chatFields),
    speed: 'standard',
    deduplicationKey: `antigravity:${cascadeId}:${responseId}`,
    userMessage: '',
    sessionId: cascadeId,
    pricingModel: normalizePricingModel(model),
  }
}

function parseFiniteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function usageSignature(event: StatusLineEvent): string {
  const u = event.usage
  return [event.model, u.inputTokens, u.outputTokens, u.cacheCreationInputTokens, u.cacheReadInputTokens].join(':')
}

function usageHasTokens(usage: StatusLineEvent['usage']): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationInputTokens > 0 ||
    usage.cacheReadInputTokens > 0
  )
}

function usageIsMonotonic(current: StatusLineEvent['usage'], previous: StatusLineEvent['usage']): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.cacheCreationInputTokens >= previous.cacheCreationInputTokens &&
    current.cacheReadInputTokens >= previous.cacheReadInputTokens
  )
}

function usageDelta(current: StatusLineEvent['usage'], previous: StatusLineEvent['usage']): StatusLineEvent['usage'] {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens - previous.cacheReadInputTokens,
  }
}

export function antigravityCascadeIdFromPath(path: string): string {
  return basename(path).replace(/\.(pb|db)$/i, '')
}

const generatorMetadataEntrySchema = Schema.Struct({ chatModel: Schema.optional(Schema.Unknown) })
const generatorChatModelSchema = Schema.Struct({
  usage: Schema.optional(Schema.Unknown),
  chatStartMetadata: Schema.optional(Schema.Unknown),
})
const generatorUsageSchema = Schema.Struct({
  model: Schema.optional(Schema.Unknown),
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  thinkingOutputTokens: Schema.optional(Schema.Unknown),
  responseOutputTokens: Schema.optional(Schema.Unknown),
  responseId: Schema.optional(Schema.Unknown),
})
const generatorStartMetadataSchema = Schema.Struct({ createdAt: Schema.optional(Schema.Unknown) })
const generatorTokenCountsSchema = Schema.Struct({
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  thinkingTokens: Schema.Finite,
  responseTokens: Schema.Finite,
})
const generatorSelectedFieldsSchema = Schema.Struct({
  model: Schema.String,
  responseId: Schema.String,
  timestamp: Schema.String,
})
const decodeGeneratorMetadataEntry = Schema.decodeUnknownResult(generatorMetadataEntrySchema)
const decodeGeneratorChatModel = Schema.decodeUnknownResult(generatorChatModelSchema)
const decodeGeneratorUsage = Schema.decodeUnknownResult(generatorUsageSchema)
const decodeGeneratorStartMetadata = Schema.decodeUnknownResult(generatorStartMetadataSchema)
const decodeGeneratorTokenCounts = Schema.decodeUnknownResult(generatorTokenCountsSchema)
const decodeGeneratorSelectedFields = Schema.decodeUnknownResult(generatorSelectedFieldsSchema)

function parseGeneratorTokenCount(value: unknown): number {
  return Number.parseInt(String(value ?? '0'), 10)
}

function decodeGeneratorMetadataCandidate(
  cascadeId: string,
  input: unknown,
  index: number,
  modelMap: ModelMap,
): { candidate: AntigravityCallCandidate | null; malformed: boolean } {
  const entryResult = decodeGeneratorMetadataEntry(input)
  if (Result.isFailure(entryResult)) return { candidate: null, malformed: true }
  if (!entryResult.success.chatModel) return { candidate: null, malformed: false }
  const chatModelResult = decodeGeneratorChatModel(entryResult.success.chatModel)
  if (Result.isFailure(chatModelResult)) return { candidate: null, malformed: true }
  if (!chatModelResult.success.usage) return { candidate: null, malformed: false }
  const usageResult = decodeGeneratorUsage(chatModelResult.success.usage)
  if (Result.isFailure(usageResult)) return { candidate: null, malformed: true }

  const usage = usageResult.success
  const inputTokens = parseGeneratorTokenCount(usage.inputTokens)
  const outputTokens = parseGeneratorTokenCount(usage.outputTokens)
  const thinkingTokens = parseGeneratorTokenCount(usage.thinkingOutputTokens)
  const responseTokens = parseGeneratorTokenCount(usage.responseOutputTokens)
  const tokenCountsResult = decodeGeneratorTokenCounts({
    inputTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
  })
  if (Result.isFailure(tokenCountsResult)) return { candidate: null, malformed: true }
  const tokenCounts = tokenCountsResult.success
  if (tokenCounts.inputTokens === 0 && tokenCounts.outputTokens === 0) {
    return { candidate: null, malformed: false }
  }

  const selectedModel = modelMap[String(usage.model)] ?? usage.model
  const startMetadata =
    chatModelResult.success.chatStartMetadata === undefined
      ? undefined
      : decodeGeneratorStartMetadata(chatModelResult.success.chatStartMetadata)
  const createdAt = startMetadata && Result.isSuccess(startMetadata) ? startMetadata.success.createdAt : undefined
  const selectedFieldsResult = decodeGeneratorSelectedFields({
    model: selectedModel,
    responseId: String(usage.responseId || index),
    timestamp: createdAt || '',
  })
  if (Result.isFailure(selectedFieldsResult)) return { candidate: null, malformed: true }
  const selectedFields = selectedFieldsResult.success
  const model = dropPlaceholderModelId(selectedFields.model)

  return {
    candidate: {
      provider: 'antigravity',
      model,
      inputTokens: tokenCounts.inputTokens,
      outputTokens: tokenCounts.responseTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: tokenCounts.thinkingTokens,
      webSearchRequests: 0,
      tools: [],
      bashCommands: [],
      timestamp: selectedFields.timestamp,
      speed: 'standard',
      deduplicationKey: `antigravity:${cascadeId}:${selectedFields.responseId}`,
      userMessage: '',
      sessionId: cascadeId,
      pricingModel: normalizePricingModel(model),
    },
    malformed: false,
  }
}

function priceAntigravityCandidate(candidate: AntigravityCallCandidate, pricing: ScanPricing): ParsedProviderCall {
  const { pricingModel, ...call } = candidate
  return {
    ...call,
    costUSD: pricing.calculateCost(
      pricingModel,
      call.inputTokens,
      billableOutputTokens('antigravity', call.outputTokens, call.reasoningTokens),
      0,
      0,
      0,
    ),
  }
}

function isConversationFile(file: string, extensions: readonly string[]): boolean {
  const lowerFile = file.toLowerCase()
  return extensions.some(ext => lowerFile.endsWith(ext))
}

export function isAntigravityStatusLineEventsPath(path: string): boolean {
  return path === getAntigravityStatusLineEventsPath()
}

const discoverIo = Effect.fnUntraced(function* <A>(
  operation: ProviderOperationError['operation'],
  run: () => Promise<A>,
  signal?: AbortSignal,
): Effect.fn.Return<A, Error> {
  return yield* scanIo(run, signal).pipe(
    Effect.mapError(cause =>
      isScanAbortedError(cause) ? cause : new ProviderOperationError({ operation, cause, message: cause.message }),
    ),
  )
})

const discoverAntigravitySessionsEffect = Effect.fnUntraced(function* (
  roots?: readonly AntigravityConversationRoot[],
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  // The statusline JSONL is a synthetic source only appended for the real
  // default roots, not when a caller passes an explicit (test) root set.
  const includeStatusLineEvents = roots === undefined
  const effectiveRoots = roots ?? conversationRoots()
  const sources: SessionSource[] = []
  const signal = context?.signal
  for (const root of effectiveRoots) {
    const entries = yield* Effect.result(discoverIo('readdir', () => readdir(root.dir), signal))
    yield* checkScanAbort(signal)
    if (entries._tag === 'Failure') {
      continue
    }

    for (const file of entries.success.sort()) {
      yield* checkScanAbort(signal)
      if (!isConversationFile(file, root.extensions)) continue
      const path = join(root.dir, file)
      const fileStat = yield* Effect.result(discoverIo('stat', () => stat(path), signal))
      yield* checkScanAbort(signal)
      if (fileStat._tag === 'Failure' || !fileStat.success.isFile()) continue
      sources.push({
        path,
        project: root.project,
        provider: 'antigravity',
      })
    }
  }

  if (includeStatusLineEvents) {
    const statusLinePath = getAntigravityStatusLineEventsPath()
    const statusLineStat = yield* Effect.result(discoverIo('stat', () => stat(statusLinePath), signal))
    yield* checkScanAbort(signal)
    if (statusLineStat._tag === 'Success' && statusLineStat.success.isFile()) {
      sources.push({
        path: statusLinePath,
        project: 'antigravity-cli',
        provider: 'antigravity',
      })
    }
  }

  return sources
})

// Remove after direct discovery callers consume the Effect-native path.
export function discoverAntigravitySessionSources(
  roots?: readonly AntigravityConversationRoot[],
): Promise<SessionSource[]> {
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(discoverAntigravitySessionsEffect(roots))
}

function parseStatusLineEvent(input: unknown): StatusLineEvent | null {
  const decoded = decodeStatusLineEventInput(input)
  if (Result.isFailure(decoded)) return null
  const event = decoded.success
  if (typeof event.at !== 'string' || Number.isNaN(new Date(event.at).getTime())) return null
  if (typeof event.conversationId !== 'string' || event.conversationId.length === 0) return null
  if (typeof event.model !== 'string' || event.model.length === 0) return null
  if (!event.usage) return null

  const usage = {
    inputTokens: parseFiniteToken(event.usage.inputTokens),
    outputTokens: parseFiniteToken(event.usage.outputTokens),
    cacheCreationInputTokens: parseFiniteToken(event.usage.cacheCreationInputTokens),
    cacheReadInputTokens: parseFiniteToken(event.usage.cacheReadInputTokens),
  }

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0
  )
    return null

  return {
    at: event.at,
    conversationId: event.conversationId,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined,
    model: event.model,
    usage,
  }
}

function hasRpcCacheForConversation(seenKeys: Set<string>, conversationId: string): boolean {
  const prefix = `antigravity:${conversationId}:`
  for (const key of seenKeys) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

type StatusLineCandidate = {
  event: StatusLineEvent
  usage: StatusLineEvent['usage']
  deduplicationKey: string
}

function statusLineCandidates(runsByConversation: StatusLineRunsByConversation): StatusLineCandidate[] {
  const candidates: StatusLineCandidate[] = []
  for (const runs of runsByConversation.values()) {
    let turnIndex = 0
    let previousSnapshotUsage: StatusLineEvent['usage'] | null = null
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index]!
      const isLastRun = index === runs.length - 1
      if (run.count === 1 && !isLastRun) continue

      const event = run.event
      const usage =
        previousSnapshotUsage && usageIsMonotonic(event.usage, previousSnapshotUsage)
          ? usageDelta(event.usage, previousSnapshotUsage)
          : event.usage
      previousSnapshotUsage = event.usage
      if (!usageHasTokens(usage)) continue

      candidates.push({
        event,
        usage,
        deduplicationKey: `antigravity-statusline:${event.conversationId}:${turnIndex++}:${run.signature}`,
      })
    }
  }
  return candidates
}

function parseStatusLineCallsStream(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  signal?: AbortSignal,
): (onUnparsedCall?: Effect.Effect<void>) => Stream.Stream<ParsedProviderCall, Error> {
  return (onUnparsedCall = Effect.void) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const runsByConversation: StatusLineRunsByConversation = new Map()
        yield* Stream.runForEach(
          readSessionLinesStream(source.path, undefined, { maxBytes: Infinity, readFailure: 'fail', signal }).pipe(
            Stream.map(line => Result.succeed(line)),
            Stream.catch(error =>
              error instanceof SessionLineReadError ? Stream.fromIterable([Result.fail(error)]) : Stream.fail(error),
            ),
          ),
          result =>
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              if (Result.isFailure(result)) {
                runsByConversation.clear()
                return
              }
              const line = result.success
              const raw = typeof line === 'string' ? line : line.toString('utf8')
              if (!raw.trim()) return

              const input = decodeStatusLineJson(raw)
              if (Result.isFailure(input)) {
                yield* onUnparsedCall
                return
              }

              const event = parseStatusLineEvent(input.success)
              if (!event) {
                yield* onUnparsedCall
                return
              }
              if (hasRpcCacheForConversation(seenKeys, event.conversationId)) return

              const signature = usageSignature(event)
              const runs = runsByConversation.get(event.conversationId) ?? []
              const lastRun = runs.at(-1)
              if (lastRun?.signature === signature) {
                lastRun.count += 1
                lastRun.event = event
              } else {
                runs.push({ event, signature, count: 1 })
                runsByConversation.set(event.conversationId, runs)
              }
            }),
        )
        yield* checkScanAbort(signal)

        // Grouping needs EOF to decide which singleton runs are final. Retain
        // only the latest compact event and count for each adjacent run.
        const candidates = statusLineCandidates(runsByConversation)
        return Stream.fromIterable(candidates).pipe(
          Stream.mapEffect(candidate =>
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              if (hasRpcCacheForConversation(seenKeys, candidate.event.conversationId)) return Result.fail(undefined)
              if (seenKeys.has(candidate.deduplicationKey)) return Result.fail(undefined)

              const costUSD = yield* Effect.try({
                try: () =>
                  pricing.calculateCost(
                    normalizePricingModel(candidate.event.model),
                    candidate.usage.inputTokens,
                    candidate.usage.outputTokens,
                    candidate.usage.cacheCreationInputTokens,
                    candidate.usage.cacheReadInputTokens,
                    0,
                  ),
                catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
              })
              seenKeys.add(candidate.deduplicationKey)
              return Result.succeed({
                provider: 'antigravity',
                model: candidate.event.model,
                inputTokens: candidate.usage.inputTokens,
                outputTokens: candidate.usage.outputTokens,
                cacheCreationInputTokens: candidate.usage.cacheCreationInputTokens,
                cacheReadInputTokens: candidate.usage.cacheReadInputTokens,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
                costUSD,
                tools: [],
                bashCommands: [],
                timestamp: candidate.event.at,
                speed: 'standard',
                deduplicationKey: candidate.deduplicationKey,
                userMessage: '',
                sessionId: candidate.event.conversationId,
                project: source.project,
              } satisfies ParsedProviderCall)
            }),
          ),
          Stream.filterMap(call => call),
        )
      }),
    )
}

export function shouldReparseAntigravitySource(path: string, cachedTurnCount: number): boolean {
  if (cachedTurnCount === 0) return true
  return isAntigravityStatusLineEventsPath(path)
}

function sanitizeProject(path: string): string {
  return basename(path.replace(/\\/g, '/'))
}

function applyAntigravityProject(
  call: ParsedProviderCall,
  source: SessionSource,
  projectPath: string | undefined,
): void {
  if (source.project === 'antigravity-cli') {
    call.project = source.project
    delete call.projectPath
    return
  }

  if (projectPath) {
    call.projectPath = projectPath
    call.project = sanitizeProject(projectPath)
    return
  }

  call.project = source.project
}

// Emit-time safety net for cache-hit / cached-fallback paths, where the calls
// already carry stable timestamps from a prior parse. Applied to a copy so the
// cache is never mutated; only fills a still-empty timestamp defensively.
function withFallbackTimestamp(call: ParsedProviderCall, fallbackTimestamp: string): ParsedProviderCall {
  return call.timestamp ? call : { ...call, timestamp: fallbackTimestamp }
}

class AntigravityConversationDatabaseError extends Schema.TaggedError<AntigravityConversationDatabaseError>()(
  'AntigravityConversationDatabaseError',
  {
    operation: Schema.Literals(['open', 'read', 'close']),
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

type OwnedAntigravityDatabase = { readonly db: SqliteDatabase; closed: boolean }

const workspaceBlobRowSchema = Schema.Struct({ data: Schema.Union([Schema.Uint8Array, Schema.String]) })
const decodeWorkspaceBlobRow = Schema.decodeUnknownResult(workspaceBlobRowSchema)

function antigravityDatabaseError(
  operation: AntigravityConversationDatabaseError['operation'],
  cause: unknown,
): AntigravityConversationDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new AntigravityConversationDatabaseError({ operation, cause: error, message: error.message })
}

function openAntigravityDatabase(
  path: string,
): Effect.Effect<OwnedAntigravityDatabase, AntigravityConversationDatabaseError> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => antigravityDatabaseError('open', cause),
  })
}

function closeAntigravityDatabase(
  owned: OwnedAntigravityDatabase,
): Effect.Effect<void, AntigravityConversationDatabaseError> {
  return Effect.suspend(() => {
    if (owned.closed) return Effect.void
    owned.closed = true
    return Effect.try({ try: () => owned.db.close(), catch: cause => antigravityDatabaseError('close', cause) })
  })
}

function workspacePathFromText(text: string): string | undefined {
  const match = text.match(/file:\/\/\/[^\x00-\x1F\x7F"'\s]+/i)
  if (!match) return undefined
  try {
    return fileURLToPath(match[0])
  } catch {
    return undefined
  }
}

function workspaceTextFromDatabaseEffect(
  filePath: string,
  signal?: AbortSignal,
  onUnparsedCall: Effect.Effect<void> = Effect.void,
): Effect.Effect<string | undefined, Error> {
  if (!filePath.toLowerCase().endsWith('.db') || !isSqliteAvailable()) return Effect.succeed(undefined)
  return Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        openAntigravityDatabase(filePath).pipe(
          Effect.catchTag('AntigravityConversationDatabaseError', error =>
            isSqliteBusyError(error.cause) ? Effect.fail(error) : Effect.succeed(null),
          ),
        ),
        owned => (owned ? closeAntigravityDatabase(owned).pipe(Effect.orDie) : Effect.void),
      )
      if (!opened) return undefined

      const queryResult = yield* Effect.result(
        Effect.try({
          try: () =>
            opened.db.query(
              `SELECT CASE WHEN typeof(data) = 'text' THEN CAST(data AS BLOB) ELSE data END AS data
               FROM trajectory_metadata_blob`,
            ),
          catch: cause => antigravityDatabaseError('read', cause),
        }),
      )
      yield* checkScanAbort(signal)
      if (Result.isFailure(queryResult)) {
        if (isSqliteBusyError(queryResult.failure.cause)) return yield* Effect.fail(queryResult.failure)
        return undefined
      }

      const textParts: string[] = []
      for (const row of queryResult.success) {
        const decoded = decodeWorkspaceBlobRow(row)
        if (Result.isFailure(decoded)) {
          yield* onUnparsedCall
          continue
        }
        textParts.push(blobToText(decoded.success.data))
      }
      yield* closeAntigravityDatabase(opened)
      const text = textParts.join(' ')
      return text || undefined
    }),
  )
}

function extractWorkspacePathEffect(
  filePath: string,
  signal?: AbortSignal,
  onUnparsedCall: Effect.Effect<void> = Effect.void,
): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    yield* checkScanAbort(signal)
    const text = yield* workspaceTextFromDatabaseEffect(filePath, signal, onUnparsedCall).pipe(
      Effect.catch(error =>
        isScanAbortedError(error) ||
        (error instanceof AntigravityConversationDatabaseError && isSqliteBusyError(error.cause))
          ? Effect.fail(error)
          : Effect.succeed(undefined),
      ),
    )
    return yield* workspacePathFromSourceTextEffect(filePath, text, signal)
  })
}

function workspacePathFromSourceTextEffect(
  filePath: string,
  initialText: string | undefined,
  signal?: AbortSignal,
): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    let text = initialText
    if (!text) {
      text = yield* scanIo(() => readFile(filePath, 'utf-8'), signal).pipe(
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(undefined))),
      )
    }
    yield* checkScanAbort(signal)
    return text ? workspacePathFromText(text) : undefined
  })
}

type AntigravitySqliteConversationSnapshot = {
  workspaceText: string | undefined
  candidates: AntigravityCallCandidate[] | null
}

function sqliteConversationSnapshotEffect(
  filePath: string,
  cascadeId: string,
  signal?: AbortSignal,
  onUnparsedCall: Effect.Effect<void> = Effect.void,
): Effect.Effect<AntigravitySqliteConversationSnapshot | null, Error> {
  if (!filePath.toLowerCase().endsWith('.db') || !isSqliteAvailable()) return Effect.succeed(null)
  return Effect.scoped(
    Effect.gen(function* () {
      yield* checkScanAbort(signal)
      const opened = yield* Effect.acquireRelease(
        openAntigravityDatabase(filePath).pipe(
          Effect.catchTag('AntigravityConversationDatabaseError', error =>
            isSqliteBusyError(error.cause) ? Effect.fail(error) : Effect.succeed(null),
          ),
        ),
        owned => (owned ? closeAntigravityDatabase(owned).pipe(Effect.orDie) : Effect.void),
      )
      if (!opened) return null

      const workspaceQuery = yield* Effect.result(
        Effect.try({
          try: () =>
            opened.db.query(
              `SELECT CASE WHEN typeof(data) = 'text' THEN CAST(data AS BLOB) ELSE data END AS data
               FROM trajectory_metadata_blob`,
            ),
          catch: cause => antigravityDatabaseError('read', cause),
        }),
      )
      yield* checkScanAbort(signal)
      if (Result.isFailure(workspaceQuery) && isSqliteBusyError(workspaceQuery.failure.cause)) {
        yield* closeAntigravityDatabase(opened)
        return yield* Effect.fail(workspaceQuery.failure)
      }
      const workspaceParts: string[] = []
      if (Result.isSuccess(workspaceQuery)) {
        for (const row of workspaceQuery.success) {
          const decoded = decodeWorkspaceBlobRow(row)
          if (Result.isFailure(decoded)) {
            yield* onUnparsedCall
            continue
          }
          workspaceParts.push(blobToText(decoded.success.data))
        }
      }

      const queryResult = yield* Effect.result(
        Effect.try({
          try: () => opened.db.query('SELECT idx, data FROM gen_metadata ORDER BY idx'),
          catch: cause => antigravityDatabaseError('read', cause),
        }),
      )
      yield* checkScanAbort(signal)
      if (Result.isFailure(queryResult)) {
        const workspaceText = workspaceParts.join(' ') || undefined
        yield* closeAntigravityDatabase(opened)
        if (isSqliteBusyError(queryResult.failure.cause)) return yield* Effect.fail(queryResult.failure)
        return { workspaceText, candidates: null }
      }

      const candidates: AntigravityCallCandidate[] = []
      const seenResponseIds = new Set<string>()
      for (const candidate of queryResult.success) {
        const decoded = decodeGenMetadataRow(candidate)
        if (Result.isFailure(decoded)) {
          yield* onUnparsedCall
          continue
        }
        const call = buildCandidateFromSqliteGenMetadataRow(cascadeId, decoded.success)
        if (!call || seenResponseIds.has(call.deduplicationKey)) continue
        seenResponseIds.add(call.deduplicationKey)
        candidates.push(call)
      }

      yield* closeAntigravityDatabase(opened)
      return { workspaceText: workspaceParts.join(' ') || undefined, candidates }
    }),
  )
}

function generatorMetadataCandidateStream(
  cascadeId: string,
  metadata: readonly unknown[],
  modelMap: ModelMap,
  onUnparsedCall: Effect.Effect<void>,
  signal?: AbortSignal,
): Stream.Stream<AntigravityCallCandidate, Error> {
  return Stream.fromIterable(metadata).pipe(
    Stream.zipWithIndex,
    Stream.mapEffect(([entry, index]) =>
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const decoded = decodeGeneratorMetadataCandidate(cascadeId, entry, index, modelMap)
        if (decoded.malformed) yield* onUnparsedCall
        return decoded.candidate ? Result.succeed(decoded.candidate) : Result.fail(undefined)
      }),
    ),
    Stream.filterMap(candidate => candidate),
  )
}

function cachedConversationCallsStream(
  calls: readonly ParsedProviderCall[],
  source: SessionSource,
  projectPath: string | undefined,
  fallbackTimestamp: string,
  seenKeys: Set<string>,
  signal?: AbortSignal,
): Stream.Stream<ParsedProviderCall, Error> {
  return Stream.fromIterable(calls).pipe(
    Stream.mapEffect(call =>
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        if (seenKeys.has(call.deduplicationKey)) return Result.fail(undefined)
        seenKeys.add(call.deduplicationKey)
        const emitted = withFallbackTimestamp({ ...call }, fallbackTimestamp)
        applyAntigravityProject(emitted, source, projectPath)
        return Result.succeed(emitted)
      }),
    ),
    Stream.filterMap(call => call),
  )
}

function priceAndCacheConversationCandidates(
  candidates: Stream.Stream<AntigravityCallCandidate, Error>,
  source: SessionSource,
  projectPath: string | undefined,
  fallbackTimestamp: string,
  priorCalls: readonly ParsedProviderCall[] | undefined,
  cascadeId: string,
  fileStat: Stats,
  cache: AntigravityCache,
  cacheCalls: ParsedProviderCall[],
  seenKeys: Set<string>,
  pricing: ScanPricing,
  signal?: AbortSignal,
): Stream.Stream<ParsedProviderCall, Error> {
  const priorTimestamps = new Map<string, string>()
  for (const prior of priorCalls ?? []) {
    if (prior.timestamp) priorTimestamps.set(prior.deduplicationKey, prior.timestamp)
  }

  const priced = candidates.pipe(
    Stream.mapEffect(candidate =>
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const timestamp = candidate.timestamp || priorTimestamps.get(candidate.deduplicationKey) || fallbackTimestamp
        const pricedCall = yield* Effect.sync(() => priceAntigravityCandidate({ ...candidate, timestamp }, pricing))
        yield* checkScanAbort(signal)
        applyAntigravityProject(pricedCall, source, projectPath)
        cacheCalls.push(pricedCall)
        if (seenKeys.has(pricedCall.deduplicationKey)) return Result.fail(undefined)
        seenKeys.add(pricedCall.deduplicationKey)
        return Result.succeed(pricedCall)
      }),
    ),
    Stream.filterMap(call => call),
  )

  return Stream.concat(
    priced,
    Stream.fromEffectDrain(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        cache.cascades[cascadeId] = {
          mtimeMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
          calls: cacheCalls,
        }
        cacheDirty = true
      }),
    ),
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing = captureScanPricing(),
  signal?: AbortSignal,
): SessionParser {
  const statusLineSource = isAntigravityStatusLineEventsPath(source.path)
  const parseConversationStream = (
    onUnparsedCall: Effect.Effect<void> = Effect.void,
  ): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const cascadeId = antigravityCascadeIdFromPath(source.path)
          const cache = yield* loadCacheEffect(signal)
          const statResult = yield* Effect.result(scanIo(() => stat(source.path), signal))
          yield* checkScanAbort(signal)
          if (Result.isFailure(statResult)) {
            if (isScanAbortedError(statResult.failure)) return yield* Effect.fail(statResult.failure)
            return Stream.empty
          }

          const fileStat = statResult.success
          const fallbackTimestamp = new Date(fileStat.mtimeMs).toISOString()
          const cached = cache.cascades[cascadeId]
          if (
            cached &&
            cached.mtimeMs === fileStat.mtimeMs &&
            cached.sizeBytes === fileStat.size &&
            cached.calls.length > 0
          ) {
            const projectPath = yield* extractWorkspacePathEffect(source.path, signal, onUnparsedCall)
            return cachedConversationCallsStream(cached.calls, source, projectPath, fallbackTimestamp, seenKeys, signal)
          }

          const sqliteSnapshot = yield* sqliteConversationSnapshotEffect(source.path, cascadeId, signal, onUnparsedCall)
          const projectPath = yield* workspacePathFromSourceTextEffect(
            source.path,
            sqliteSnapshot?.workspaceText,
            signal,
          )
          const sqliteCandidates = sqliteSnapshot?.candidates ?? null
          if (sqliteCandidates && sqliteCandidates.length > 0) {
            const cacheCalls: ParsedProviderCall[] = []
            return priceAndCacheConversationCandidates(
              Stream.fromIterable(sqliteCandidates),
              source,
              projectPath,
              fallbackTimestamp,
              cached?.calls,
              cascadeId,
              fileStat,
              cache,
              cacheCalls,
              seenKeys,
              pricing,
              signal,
            )
          }

          const server = yield* detectServerEffect(antigravityAppDataDirFromSourcePath(source.path), signal)
          if (!server) {
            return cached
              ? cachedConversationCallsStream(cached.calls, source, projectPath, fallbackTimestamp, seenKeys, signal)
              : Stream.empty
          }

          const modelMap = yield* getModelMapEffect(server, signal)
          const metadata = yield* rpcEffect(
            server,
            'GetCascadeTrajectoryGeneratorMetadata',
            { cascadeId },
            signal,
          ).pipe(
            Effect.map(extractAntigravityGeneratorMetadata),
            Effect.catchTag('AntigravityRpcError', () => Effect.succeed(null)),
          )
          if (metadata === null) {
            return cached
              ? cachedConversationCallsStream(cached.calls, source, projectPath, fallbackTimestamp, seenKeys, signal)
              : Stream.empty
          }

          const cacheCalls: ParsedProviderCall[] = []
          return priceAndCacheConversationCandidates(
            generatorMetadataCandidateStream(cascadeId, metadata, modelMap, onUnparsedCall, signal),
            source,
            projectPath,
            fallbackTimestamp,
            cached?.calls,
            cascadeId,
            fileStat,
            cache,
            cacheCalls,
            seenKeys,
            pricing,
            signal,
          )
        }),
      ),
    )

  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    statusLineSource
      ? parseStatusLineCallsStream(source, seenKeys, pricing, signal)(onUnparsedCall)
      : parseConversationStream(onUnparsedCall)

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const iterator = Stream.toAsyncIterable(parseStream())[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await iterator.next()
          if (next.done) return
          yield next.value
        }
      } catch (error) {
        if (error instanceof AntigravityConversationDatabaseError) throw error.cause
        throw error
      } finally {
        await iterator.return?.()
      }
    },
  }
}

const modelDisplayNames: Record<string, string> = {
  'gemini-pro-agent': 'Gemini Pro',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-agent': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Low)': 'Gemini 3.5 Flash',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'claude-opus-4-6-thinking': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

export function createAntigravityProvider(): Provider {
  const discover = (context?: ProviderScanContext) => discoverAntigravitySessionsEffect(undefined, context)
  return {
    name: 'antigravity',
    displayName: 'Antigravity',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: discover,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove this Promise edge once direct discovery callers consume the native hook.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discover(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, context?.pricing ?? captureScanPricing(), context?.signal)
    },
  }
}

export async function flushAntigravityCache(liveCascadeIds?: Set<string>): Promise<void> {
  await flushCache(liveCascadeIds)
}

export const antigravity = createAntigravityProvider()
