import type { Dirent } from 'node:fs'

import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, dirname, join, resolve } from 'path'

import { billableOutputTokens } from '../billable-output.js'
import { readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const lingtaiManifestSchema = Schema.Struct({
  agent_id: Schema.optional(Schema.Unknown),
  agent_name: Schema.optional(Schema.Unknown),
  address: Schema.optional(Schema.Unknown),
  nickname: Schema.optional(Schema.Unknown),
  llm: Schema.optional(Schema.Unknown),
})
const lingtaiLedgerEntrySchema = Schema.Struct({
  source: Schema.optional(Schema.Unknown),
  em_id: Schema.optional(Schema.Unknown),
  run_id: Schema.optional(Schema.Unknown),
  ts: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  thinking: Schema.optional(Schema.Unknown),
  cached: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  endpoint: Schema.optional(Schema.Unknown),
})
const registryEntrySchema = Schema.Struct({ path: Schema.optional(Schema.Unknown) })
const projectMetaSchema = Schema.Struct({ project_path: Schema.optional(Schema.Unknown) })
const llmManifestSchema = Schema.Struct({
  model: Schema.optional(Schema.Unknown),
  base_url: Schema.optional(Schema.Unknown),
})
const jsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const stringSchema = Schema.String
const numericSchema = Schema.Union([Schema.Finite, Schema.String])
const timestampSchema = Schema.Union([Schema.Finite, Schema.String])
const decodeManifest = Schema.decodeUnknownResult(lingtaiManifestSchema)
const decodeLedgerEntry = Schema.decodeUnknownResult(lingtaiLedgerEntrySchema)
const decodeRegistryEntry = Schema.decodeUnknownResult(registryEntrySchema)
const decodeProjectMeta = Schema.decodeUnknownResult(projectMetaSchema)
const decodeLlmManifest = Schema.decodeUnknownResult(llmManifestSchema)
const decodeObject = Schema.decodeUnknownResult(jsonObjectSchema)
const decodeString = Schema.decodeUnknownResult(stringSchema)
const decodeNumeric = Schema.decodeUnknownResult(numericSchema)
const decodeTimestamp = Schema.decodeUnknownResult(timestampSchema)
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

type LingTaiAgentManifest = {
  agent_id?: string
  agent_name?: string
  address?: string
  nickname?: string | null
  llm?: {
    model?: string
    base_url?: string
  }
}

type LingTaiProviderOptions = {
  lingtaiHomeOverride?: string
  defaultHomeOverride?: string
  globalDirOverride?: string
  cwdOverride?: string
}

type LingTaiHome = {
  path: string
  projectPrefix?: string
}

function normalizeOptions(options?: string | LingTaiProviderOptions): LingTaiProviderOptions {
  return typeof options === 'string' ? { lingtaiHomeOverride: options } : (options ?? {})
}

function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function splitPathList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(delimiter)
    .map(path => path.trim())
    .filter(Boolean)
}

function getDefaultLingTaiHome(options: LingTaiProviderOptions): string {
  return options.defaultHomeOverride ?? join(homedir(), '.lingtai')
}

function getLingTaiGlobalDir(options: LingTaiProviderOptions): string {
  return options.globalDirOverride ?? process.env['LINGTAI_TUI_GLOBAL_DIR'] ?? join(homedir(), '.lingtai-tui')
}

function projectPrefixFromHome(lingtaiHome: string, defaultLingTaiHome: string): string | undefined {
  const defaultHome = resolve(expandHome(defaultLingTaiHome))
  const resolved = resolve(lingtaiHome)
  if (resolved === defaultHome) return undefined

  const projectName = basename(dirname(resolved))
  return projectName && projectName !== '.' ? sanitizeProject(projectName) : undefined
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'lingtai'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function stringField(obj: Record<string, unknown> | null, key: string): string | undefined {
  const decoded = decodeString(obj?.[key])
  return Result.isSuccess(decoded) && decoded.success.trim() ? decoded.success : undefined
}

function numericField(obj: Record<string, unknown>, key: string): number {
  const decoded = decodeNumeric(obj[key])
  if (Result.isFailure(decoded)) return 0
  const n = typeof decoded.success === 'number' ? decoded.success : Number(decoded.success)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

function parseJson(raw: string): unknown | null {
  if (!raw) return null
  const decoded = decodeJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function readJsonEffect(path: string, signal?: AbortSignal): Effect.Effect<unknown | null, Error> {
  return scanIo(() => readFile(path, 'utf-8'), signal).pipe(
    Effect.map(parseJson),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
}

function readAgentManifestEffect(
  agentDir: string,
  signal?: AbortSignal,
): Effect.Effect<LingTaiAgentManifest | null, Error> {
  return Effect.gen(function* () {
    const parsed = yield* readJsonEffect(join(agentDir, '.agent.json'), signal)
    const decoded = decodeManifest(parsed)
    if (Result.isFailure(decoded)) return null

    const manifest = decoded.success
    const llmObject = decodeObject(manifest.llm)
    const decodedLlm = Result.isSuccess(llmObject) ? decodeLlmManifest(llmObject.success) : null
    const llm = decodedLlm && Result.isSuccess(decodedLlm) ? decodedLlm.success : null
    return {
      agent_id: stringField(manifest, 'agent_id'),
      agent_name: stringField(manifest, 'agent_name'),
      address: stringField(manifest, 'address'),
      nickname: stringField(manifest, 'nickname') ?? null,
      llm: llm ? { model: stringField(llm, 'model'), base_url: stringField(llm, 'base_url') } : undefined,
    }
  })
}

function readDirectoryEntriesEffect(path: string, signal?: AbortSignal): Effect.Effect<Dirent[] | null, Error> {
  return scanIo(() => readdir(path, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
}

function readRegisteredProjectPathsEffect(globalDir: string, signal?: AbortSignal): Effect.Effect<string[], Error> {
  return Effect.gen(function* () {
    const projects: string[] = []
    const registryRaw = yield* scanIo(() => readFile(join(globalDir, 'registry.jsonl'), 'utf-8'), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(''))),
    )
    for (const line of registryRaw.split(/\r?\n/)) {
      yield* checkScanAbort(signal)
      if (!line.trim()) continue
      const parsed = parseJson(line)
      const decoded = decodeRegistryEntry(parsed)
      if (Result.isFailure(decoded)) continue
      const path = stringField(decoded.success, 'path')
      if (path) projects.push(path)
    }

    const briefDir = join(globalDir, 'brief', 'projects')
    const entries = yield* readDirectoryEntriesEffect(briefDir, signal)
    for (const entry of entries ?? []) {
      yield* checkScanAbort(signal)
      if (!entry.isDirectory()) continue
      const meta = yield* readJsonEffect(join(briefDir, entry.name, 'meta.json'), signal)
      const decoded = decodeProjectMeta(meta)
      if (Result.isFailure(decoded)) continue
      const path = stringField(decoded.success, 'project_path')
      if (path) projects.push(path)
    }
    return projects
  })
}

function cwdLingTaiHomes(cwd: string): string[] {
  const homes: string[] = []
  let current = resolve(cwd)
  for (;;) {
    homes.push(join(current, '.lingtai'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return homes
}

function existingDirEffect(path: string, signal?: AbortSignal): Effect.Effect<string | null, Error> {
  const resolved = resolve(expandHome(path))
  return scanIo(() => stat(resolved), signal).pipe(
    Effect.map(info => (info.isDirectory() ? resolved : null)),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
}

const getLingTaiHomesEffect = Effect.fnUntraced(function* (
  options: LingTaiProviderOptions,
  context?: ProviderScanContext,
): Effect.fn.Return<LingTaiHome[], Error> {
  const signal = context?.signal
  yield* checkScanAbort(signal)
  const explicit = splitPathList(
    options.lingtaiHomeOverride ?? process.env['LINGTAI_HOME'] ?? process.env['LINGTAI_TUI_HOME'],
  )
  const defaultHome = getDefaultLingTaiHome(options)
  let candidates: string[]
  if (explicit.length > 0) {
    candidates = explicit
  } else {
    const registeredPaths = yield* readRegisteredProjectPathsEffect(getLingTaiGlobalDir(options), signal)
    candidates = [
      defaultHome,
      ...registeredPaths.map(project => join(project, '.lingtai')),
      ...cwdLingTaiHomes(options.cwdOverride ?? process.cwd()),
    ]
  }

  const seen = new Set<string>()
  const homes: LingTaiHome[] = []
  for (const candidate of candidates) {
    yield* checkScanAbort(signal)
    const path = yield* existingDirEffect(candidate, signal)
    if (!path || seen.has(path)) continue
    seen.add(path)
    homes.push({ path, projectPrefix: explicit.length ? undefined : projectPrefixFromHome(path, defaultHome) })
  }
  return homes
})

function projectFromManifest(manifest: LingTaiAgentManifest | null, fallback: string, prefix?: string): string {
  const name = sanitizeProject(manifest?.nickname ?? manifest?.agent_name ?? manifest?.address ?? fallback)
  return prefix ? `${prefix}-${name}` : name
}

function parseTimestamp(raw: unknown): string {
  const decoded = decodeTimestamp(raw)
  if (Result.isFailure(decoded)) return ''
  if (typeof decoded.success === 'number') {
    const ms = decoded.success < 1e12 ? decoded.success * 1000 : decoded.success
    return new Date(ms).toISOString()
  }
  if (!decoded.success.trim()) return ''
  const date = new Date(decoded.success)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function agentDirFromLedgerPath(ledgerPath: string): string {
  return dirname(dirname(ledgerPath))
}

function parseLedgerLine(line: string | Buffer): Record<string, unknown> | null {
  const text = Buffer.isBuffer(line) ? line.toString('utf-8') : line
  if (!text.trim()) return null
  const decodedJson = decodeJson(text)
  if (Result.isFailure(decodedJson)) return null
  const decodedEntry = decodeLedgerEntry(decodedJson.success)
  return Result.isSuccess(decodedEntry) ? decodedEntry.success : null
}

function activityForSource(sourceLabel: string): { userMessage: string; tools: string[]; subagentTypes: string[] } {
  const normalized = sourceLabel.trim().toLowerCase()

  if (normalized === 'tc_wake' || normalized.startsWith('tc_') || normalized.includes('wake')) {
    return {
      userMessage: 'LingTai task coordinator wake',
      tools: ['Agent'],
      subagentTypes: ['lingtai-task-coordinator'],
    }
  }

  if (normalized === 'daemon') {
    return {
      userMessage: 'LingTai daemon task',
      tools: ['Agent'],
      subagentTypes: ['lingtai-daemon'],
    }
  }

  if (normalized === 'summarize_apriori' || normalized.includes('summar')) {
    return {
      userMessage: 'LingTai planning summary',
      tools: ['EnterPlanMode'],
      subagentTypes: [],
    }
  }

  return {
    userMessage: normalized === 'main' ? 'LingTai main conversation' : `LingTai ${sourceLabel || 'main'} conversation`,
    tools: [],
    subagentTypes: [],
  }
}

function discoverLedgersInHomeEffect(home: LingTaiHome, signal?: AbortSignal): Effect.Effect<SessionSource[], Error> {
  return Effect.gen(function* () {
    const entries = yield* readDirectoryEntriesEffect(home.path, signal)
    const sources: SessionSource[] = []
    for (const entry of entries ?? []) {
      yield* checkScanAbort(signal)
      if (!entry.isDirectory()) continue
      const agentDir = join(home.path, entry.name)
      const ledgerPath = join(agentDir, 'logs', 'token_ledger.jsonl')
      const ledgerStat = yield* scanIo(() => stat(ledgerPath), signal).pipe(
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
      )
      if (!ledgerStat?.isFile()) continue

      const manifest = yield* readAgentManifestEffect(agentDir, signal)
      sources.push({
        path: ledgerPath,
        project: projectFromManifest(manifest, entry.name, home.projectPrefix),
        provider: 'lingtai-tui',
      })
    }
    return sources
  })
}

function discoverLedgersEffect(homes: LingTaiHome[], signal?: AbortSignal): Effect.Effect<SessionSource[], Error> {
  return Effect.gen(function* () {
    const sources: SessionSource[] = []
    const seen = new Set<string>()
    for (const home of homes) {
      yield* checkScanAbort(signal)
      for (const source of yield* discoverLedgersInHomeEffect(home, signal)) {
        if (seen.has(source.path)) continue
        seen.add(source.path)
        sources.push(source)
      }
    }
    return sources
  })
}

function createParser(source: SessionSource, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const agentDir = agentDirFromLedgerPath(source.path)
        const manifest = yield* readAgentManifestEffect(agentDir, signal)
        yield* checkScanAbort(signal)
        const agentId = manifest?.agent_id ?? basename(agentDir)
        const fallbackModel = manifest?.llm?.model ?? 'unknown'
        const fallbackEndpoint = manifest?.llm?.base_url ?? ''
        const project = source.project || projectFromManifest(manifest, basename(agentDir))
        const projectPath = agentDir
        let lineNo = 0

        return readSessionLinesStream(source.path, undefined, signal ? { signal } : {}).pipe(
          Stream.mapEffect(line =>
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              lineNo += 1
              const entry = parseLedgerLine(line)
              if (!entry) return Result.fail(undefined)

              const inputTotal = numericField(entry, 'input')
              const outputTokens = numericField(entry, 'output')
              const reasoningTokens = numericField(entry, 'thinking')
              const cachedInputTokens = numericField(entry, 'cached')
              const totalTokens = inputTotal + outputTokens + reasoningTokens + cachedInputTokens
              if (totalTokens === 0) return Result.fail(undefined)

              // LingTai stores cached usage inside its input total.
              const inputTokens = Math.max(0, inputTotal - cachedInputTokens)
              const model = stringField(entry, 'model') ?? fallbackModel
              const endpoint = stringField(entry, 'endpoint') ?? fallbackEndpoint
              const timestamp = parseTimestamp(entry['ts'])
              const sourceLabel = stringField(entry, 'source') ?? 'main'
              const emId = stringField(entry, 'em_id') ?? ''
              const runId = stringField(entry, 'run_id') ?? ''
              const sessionId = runId || `${agentId}:${sourceLabel}`
              const activity = activityForSource(sourceLabel)
              const dedupKey = [
                'lingtai-tui',
                source.path,
                lineNo,
                timestamp,
                model,
                endpoint,
                sourceLabel,
                emId,
                runId,
                inputTotal,
                outputTokens,
                reasoningTokens,
                cachedInputTokens,
              ].join(':')
              const costUSD = yield* Effect.try({
                try: () =>
                  pricing.calculateCost(
                    model,
                    inputTokens,
                    billableOutputTokens('lingtai-tui', outputTokens, reasoningTokens),
                    0,
                    cachedInputTokens,
                    0,
                  ),
                catch: toError,
              })

              const call: ParsedProviderCall = {
                provider: 'lingtai-tui',
                model,
                inputTokens,
                outputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: cachedInputTokens,
                cachedInputTokens,
                reasoningTokens,
                webSearchRequests: 0,
                costUSD,
                tools: activity.tools,
                bashCommands: [],
                subagentTypes: activity.subagentTypes,
                timestamp,
                speed: 'standard',
                deduplicationKey: dedupKey,
                turnId: `${sessionId}:line:${lineNo}`,
                userMessage: activity.userMessage,
                sessionId,
                project,
                projectPath,
              }
              yield* checkScanAbort(signal)
              return Result.succeed(call)
            }),
          ),
          Stream.filterMap(call => call),
        )
      }),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Remove when direct parser callers consume parseStream.
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createLingTaiTuiProvider(options?: string | LingTaiProviderOptions): Provider {
  const providerOptions = normalizeOptions(options)
  const discoverEffect = (context?: ProviderScanContext) =>
    Effect.gen(function* () {
      const homes = yield* getLingTaiHomesEffect(providerOptions, context)
      return yield* discoverLedgersEffect(homes, context?.signal)
    })

  return {
    name: 'lingtai-tui',
    displayName: 'LingTai TUI',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: discoverEffect,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove when external discovery callers use discoverSessionsEffect.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      _seenKeys?: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, context)
    },
  }
}

export const lingtaiTui = createLingTaiTuiProvider()
