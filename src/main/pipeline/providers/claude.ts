import { createHash } from 'crypto'
import { Effect, Result, Schema } from 'effect'
import { readdirSync, statSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter as pathDelimiter, join, resolve } from 'path'

import { type AppPaths, overrideFor, platformFor } from '../../env.js'
import { reportProviderIssue } from '../file-errors.js'
import { getShortModelName } from '../models.js'
import { scanAbortError } from '../scan-control.js'
import type { ProbeRoot, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

export type ClaudeConfigSource = {
  id: string
  label: string
  path: string
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function dedupeResolved(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

function claudeConfigSourceId(path: string): string {
  return 'claude-config:' + createHash('sha256').update(path).digest('hex').slice(0, 16)
}

function baseClaudeConfigLabel(path: string): string {
  const normalized = resolve(path)
  if (normalized === resolve(join(homedir(), '.claude'))) return 'Default Claude'
  const name = basename(normalized).replace(/^\./, '').trim()
  return name || normalized
}

function makeUniqueLabels(sources: ClaudeConfigSource[]): ClaudeConfigSource[] {
  const counts = new Map<string, number>()
  for (const source of sources) counts.set(source.label, (counts.get(source.label) ?? 0) + 1)
  if (![...counts.values()].some(count => count > 1)) return sources

  const seen = new Map<string, number>()
  return sources.map(source => {
    if ((counts.get(source.label) ?? 0) <= 1) return source
    const index = (seen.get(source.label) ?? 0) + 1
    seen.set(source.label, index)
    return { ...source, label: `${source.label} ${index}` }
  })
}

const writable = Schema.mutableKey
const claudeConfigSchema = Schema.Struct({
  claudeConfigDirs: writable(Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown)))),
})
const claudeConfigJsonSchema = Schema.fromJsonString(claudeConfigSchema)
const coworkSpacesContainerSchema = Schema.Struct({ spaces: writable(Schema.mutable(Schema.Array(Schema.Unknown))) })
const coworkSpaceSchema = Schema.Struct({ id: writable(Schema.String), name: writable(Schema.String) })
const coworkSessionSchema = Schema.Struct({
  spaceId: writable(Schema.optional(Schema.Unknown)),
  userSelectedFolders: writable(Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown)))),
  title: writable(Schema.optional(Schema.Unknown)),
})

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

/** Ignore one malformed optional field without dropping valid sibling data. */
function decodeOptionalString(value: unknown): string | undefined {
  const decoded = Schema.decodeUnknownResult(Schema.String)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function checkDiscoveryAbort(context?: ProviderScanContext): Effect.Effect<void, Error> {
  return Effect.suspend(() => (context?.signal?.aborted ? Effect.fail(scanAbortError(context.signal)) : Effect.void))
}

/** A native filesystem call must finish before its caller can release scan ownership. */
function claudeFileIo<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: toError }))
}

function readClaudeFile(path: string, context?: ProviderScanContext): Effect.Effect<string, Error> {
  return claudeFileIo(() =>
    readFile(path, {
      encoding: 'utf-8',
      ...(context?.signal ? { signal: context.signal } : {}),
    }),
  )
}

const getClaudeConfigDirsEffect = Effect.fnUntraced(function* (
  context?: ProviderScanContext,
  paths?: AppPaths,
): Effect.fn.Return<string[], Error> {
  yield* checkDiscoveryAbort(context)
  const multi = overrideFor(paths, 'CLAUDE_CONFIG_DIRS')
  if (multi !== undefined && multi !== '') {
    const dirs = multi
      .split(pathDelimiter)
      .map(value => value.trim())
      .filter(value => value.length > 0)
      .map(value => resolve(expandHome(value)))
    if (dirs.length > 0) return dedupeResolved(dirs)
  }

  const single = overrideFor(paths, 'CLAUDE_CONFIG_DIR')
  if (single !== undefined && single !== '') return [resolve(expandHome(single))]

  const configRead = yield* Effect.result(
    readClaudeFile(join(homedir(), '.config', 'watchtower', 'config.json'), context),
  )
  yield* checkDiscoveryAbort(context)
  if (Result.isSuccess(configRead)) {
    const decoded = yield* Schema.decodeUnknownEffect(claudeConfigJsonSchema)(configRead.success).pipe(
      Effect.catch(() => Effect.succeed(null)),
    )
    if (decoded?.claudeConfigDirs) {
      const dirs = decoded.claudeConfigDirs
        .map(decodeOptionalString)
        .filter((value): value is string => value !== undefined && value.trim().length > 0)
        .map(value => resolve(expandHome(value.trim())))
      if (dirs.length > 0) return dedupeResolved(dirs)
    }
  }
  return [join(homedir(), '.claude')]
})

/// Returns every Claude config dir to scan, in priority order with duplicates
/// removed (resolved-path equality). Precedence: `CLAUDE_CONFIG_DIRS` (a
/// `path.delimiter`-separated list, ":" on POSIX, ";" on Windows), then
/// `CLAUDE_CONFIG_DIR` (single dir), then the `claudeConfigDirs` array in
/// `~/.config/watchtower/config.json` (how the desktop app configures
/// multi-account aggregation, since a GUI app can't inherit the shell env),
/// then `~/.claude`. Sessions from every returned dir are merged into one
/// ProjectSummary per project name in `src/parser.ts:scanProjectDirs`, so two
/// dirs holding the same sanitized project slug naturally aggregate (#208).
///
/// `paths` is the trailing AppPaths snapshot seam (`env.ts` convention): both
/// env vars are read through `overrideFor`, which reports the raw string. The
/// normalization below stays here — an empty value is still skipped by the
/// `!== ''` checks, which is what `process.env[...] === undefined` used to do.
export async function getClaudeConfigDirs(paths?: AppPaths): Promise<string[]> {
  // Compatibility edge for callers that still expose Promise APIs.
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(getClaudeConfigDirsEffect(undefined, paths))
}

const discoverClaudeConfigSourcesEffect = Effect.fnUntraced(function* (
  context?: ProviderScanContext,
): Effect.fn.Return<ClaudeConfigSource[], Error> {
  const dirs = yield* getClaudeConfigDirsEffect(context)
  return makeUniqueLabels(
    dirs.map(path => ({
      id: claudeConfigSourceId(path),
      label: baseClaudeConfigLabel(path),
      path,
    })),
  )
})

// Filesystem changes under an unchanged input key intentionally do not invalidate this cache.
const desktopSessionsDirsCache = new Map<string, string[]>()

function cacheDesktopSessionsDirs(key: string, candidates: string[]): string[] {
  const dirs = dedupeResolved(candidates.map(candidate => resolve(candidate)))
  desktopSessionsDirsCache.set(key, dirs)
  return [...dirs]
}

export function getDesktopSessionsDirs(paths?: AppPaths): string[] {
  const override = overrideFor(paths, 'WATCHTOWER_DESKTOP_SESSIONS_DIR')
  // `appDataInput` / `localAppDataInput` are `string | null` on the snapshot
  // ("null means unset"), so both normalization sites below stay byte-identical
  // to the old `string | undefined` reads: the cache key's `?? null` collapses
  // unset to `null` either way, and `?.trim() || default` treats `null` exactly
  // like `undefined`. `''` and `'  '` are still real values, still reach the
  // join verbatim, and still collapse to the homedir default by the `||`.
  const platformEnv = platformFor(paths)
  const appDataInput = platformEnv.appData
  const localAppDataInput = platformEnv.localAppData
  // The only `process.*` read left in this file, and deliberately so: the OS
  // name is not an env var, so `AppPaths` has no field for it (the env-only rule
  // in #148 §5.2 and `docs/architecture.md` keeps this file env-only).
  // Everything env-shaped comes from the snapshot.
  const platform = process.platform
  const cacheKey = JSON.stringify([platform, override ?? null, appDataInput ?? null, localAppDataInput ?? null])
  const cached = desktopSessionsDirsCache.get(cacheKey)
  if (cached) return [...cached]

  if (override) return cacheDesktopSessionsDirs(cacheKey, [override])
  if (platform === 'darwin') {
    return cacheDesktopSessionsDirs(cacheKey, [
      join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    ])
  }
  if (platform === 'win32') {
    const appData = appDataInput?.trim()
    const candidates = [join(appData || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions')]

    const localAppData = localAppDataInput?.trim()
    const packagesDir = join(localAppData || join(homedir(), 'AppData', 'Local'), 'Packages')
    try {
      const entries = readdirSync(packagesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && (entry.name.startsWith('Claude_') || entry.name.includes('.Claude_')))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

      for (const entry of entries) {
        const sessionsDir = join(
          packagesDir,
          entry.name,
          'LocalCache',
          'Roaming',
          'Claude',
          'local-agent-mode-sessions',
        )
        try {
          if (statSync(sessionsDir).isDirectory()) candidates.push(sessionsDir)
        } catch {
          // A package may disappear or be unreadable while Packages is scanned.
        }
      }
    } catch {
      // Missing or unreadable Packages is equivalent to no MSIX candidates.
    }

    return cacheDesktopSessionsDirs(cacheKey, candidates)
  }
  return cacheDesktopSessionsDirs(cacheKey, [join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')])
}

const findDesktopProjectDirsEffect = Effect.fnUntraced(function* (
  base: string,
  context?: ProviderScanContext,
): Effect.fn.Return<string[], Error> {
  const results: string[] = []
  const walk = Effect.fnUntraced(function* (dir: string, depth: number): Effect.fn.Return<void, Error> {
    yield* checkDiscoveryAbort(context)
    if (depth > 8) return
    const entriesResult = yield* Effect.result(claudeFileIo(() => readdir(dir)))
    yield* checkDiscoveryAbort(context)
    if (Result.isFailure(entriesResult)) return
    for (const entry of entriesResult.success) {
      yield* checkDiscoveryAbort(context)
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      const statResult = yield* Effect.result(claudeFileIo(() => stat(full)))
      yield* checkDiscoveryAbort(context)
      if (Result.isFailure(statResult) || !statResult.success.isDirectory()) continue
      if (entry === 'projects') {
        const projectEntries = yield* Effect.result(claudeFileIo(() => readdir(full)))
        yield* checkDiscoveryAbort(context)
        if (Result.isFailure(projectEntries)) continue
        for (const projectEntry of projectEntries.success) {
          yield* checkDiscoveryAbort(context)
          const projectPath = join(full, projectEntry)
          const projectStat = yield* Effect.result(claudeFileIo(() => stat(projectPath)))
          yield* checkDiscoveryAbort(context)
          if (Result.isSuccess(projectStat) && projectStat.success.isDirectory()) results.push(projectPath)
        }
      } else {
        yield* walk(full, depth + 1)
      }
    }
  })
  yield* walk(base, 0)
  return results
})

// ── Cowork space resolution ────────────────────────────────────────────
// Claude Desktop's local-agent-mode creates one directory per session under
//   <desktopSessionsDir>/<appId>/<workspaceId>/local_<sessionId>/
// Inside each session directory Claude Code stores its own config at
//   .claude/projects/<sanitized-cwd>/
// which is what findDesktopProjectDirs picks up. The actual project name
// lives in the sibling <workspaceId>/local_<sessionId>.json (spaceId field)
// and <workspaceId>/spaces.json (id → name mapping).

// Cache spaces.json per workspace directory to avoid redundant reads.
const spacesJsonCache = new Map<string, CoworkSpacesFile | null>()

type CoworkSpace = typeof coworkSpaceSchema.Type
type CoworkSpacesFile = { spaces: CoworkSpace[] }

const loadSpacesJsonEffect = Effect.fnUntraced(function* (
  workspaceDir: string,
  context?: ProviderScanContext,
): Effect.fn.Return<CoworkSpacesFile | null, Error> {
  if (spacesJsonCache.has(workspaceDir)) return spacesJsonCache.get(workspaceDir) ?? null
  const read = yield* Effect.result(readClaudeFile(join(workspaceDir, 'spaces.json'), context))
  yield* checkDiscoveryAbort(context)
  if (Result.isFailure(read)) {
    spacesJsonCache.set(workspaceDir, null)
    return null
  }
  const container = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(coworkSpacesContainerSchema))(
    read.success,
  ).pipe(Effect.catch(() => Effect.succeed(null)))
  const spaces: CoworkSpace[] = []
  for (const candidate of container?.spaces ?? []) {
    const decoded = yield* Schema.decodeUnknownEffect(coworkSpaceSchema)(candidate).pipe(
      Effect.catch(() => Effect.succeed(null)),
    )
    if (decoded) spaces.push(decoded)
  }
  const result = container ? { spaces } : null
  spacesJsonCache.set(workspaceDir, result)
  return result
})

const resolveCoworkSpaceNameEffect = Effect.fnUntraced(function* (
  workspaceDir: string,
  sessionId: string,
  context?: ProviderScanContext,
): Effect.fn.Return<string | null, Error> {
  const [spacesFile, sessionMetaRead] = yield* Effect.all([
    loadSpacesJsonEffect(workspaceDir, context),
    Effect.result(readClaudeFile(join(workspaceDir, `${sessionId}.json`), context)),
  ])
  yield* checkDiscoveryAbort(context)
  if (Result.isFailure(sessionMetaRead)) return null
  const meta = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(coworkSessionSchema))(
    sessionMetaRead.success,
  ).pipe(Effect.catch(() => Effect.succeed(null)))
  if (!meta) return null
  const spaceId = decodeOptionalString(meta.spaceId)
  if (spaceId !== undefined && spacesFile) {
    const spaceName = spacesFile.spaces.find(space => space.id === spaceId)?.name
    if (spaceName) return spaceName
  }
  const folder = decodeOptionalString(meta.userSelectedFolders?.[0])
  if (folder !== undefined) return basename(folder)
  const title = decodeOptionalString(meta.title)?.trim()
  if (title) return title
  return null
})

const discoverClaudeSessionsEffect = Effect.fnUntraced(function* (
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkDiscoveryAbort(context)
  const sources: SessionSource[] = []
  const seenProjectDirs = new Set<string>()
  const configSources = yield* discoverClaudeConfigSourcesEffect(context)
  let anyDirReadable = false

  for (const configSource of configSources) {
    yield* checkDiscoveryAbort(context)
    const projectsDir = join(configSource.path, 'projects')
    const entriesRead = yield* Effect.result(claudeFileIo(() => readdir(projectsDir)))
    yield* checkDiscoveryAbort(context)
    if (Result.isFailure(entriesRead)) {
      // Missing or unreadable dir is not fatal: a user can configure both
      // a real and a stale path in CLAUDE_CONFIG_DIRS without breaking.
      continue
    }
    anyDirReadable = true
    for (const dirName of entriesRead.success) {
      yield* checkDiscoveryAbort(context)
      const dirPath = join(projectsDir, dirName)
      // Resolve before deduping so two CLAUDE_CONFIG_DIRS entries that
      // reach the same projects/<slug> directory (via symlinks or
      // overlapping configs) emit only one SessionSource.
      const resolved = resolve(dirPath)
      if (seenProjectDirs.has(resolved)) continue
      const dirStat = yield* Effect.result(claudeFileIo(() => stat(dirPath)))
      yield* checkDiscoveryAbort(context)
      if (Result.isFailure(dirStat) || !dirStat.success.isDirectory()) continue
      seenProjectDirs.add(resolved)
      // `project: dirName` is identical across config dirs for the same
      // sanitized slug, which is exactly what makes the parser merge
      // their sessions into a single ProjectSummary.
      sources.push({
        path: dirPath,
        project: dirName,
        provider: 'claude',
        sourceId: configSource.id,
        sourceLabel: configSource.label,
        sourcePath: configSource.path,
        sourceKind: 'claude-config',
      })
    }
  }

  // If the user explicitly set CLAUDE_CONFIG_DIRS and every entry was
  // unreadable, emit a one-line stderr hint. Catches the most common
  // misconfiguration: a Windows user typing `:` (POSIX delimiter) when
  // the platform expects `;`, which produces a single bogus path that
  // silently resolves to nothing on disk.
  const explicitMulti = overrideFor(undefined, 'CLAUDE_CONFIG_DIRS')
  if (!anyDirReadable && explicitMulti !== undefined && explicitMulti !== '' && configSources.length > 0) {
    // User-configured paths never reach any output — provider + code only.
    yield* Effect.sync(() => reportProviderIssue('claude', 'config-unreadable'))
  }

  for (const desktopBase of getDesktopSessionsDirs()) {
    yield* checkDiscoveryAbort(context)
    const desktopDirs = yield* findDesktopProjectDirsEffect(desktopBase, context)
    const sep = desktopBase.includes('\\') ? '\\' : '/'
    // Desktop / Cowork sessions belong to no CLAUDE_CONFIG_DIR. Tag them with a
    // distinct source so a per-config view can account for them as their own
    // "Claude Desktop" bucket instead of silently dropping them (which made
    // sum-of-configs < All).
    const desktopSourceId =
      'claude-desktop:' + createHash('sha256').update(resolve(desktopBase)).digest('hex').slice(0, 16)
    for (const dirPath of desktopDirs) {
      yield* checkDiscoveryAbort(context)
      const resolved = resolve(dirPath)
      if (seenProjectDirs.has(resolved)) continue
      seenProjectDirs.add(resolved)

      // For Claude Desktop local-agent-mode (Cowork) sessions, the project dir
      // lives inside local_<sessionId>/.claude/projects/. We resolve the space
      // name from the sibling .json and spaces.json so it groups correctly.
      // Path structure: <desktopBase>/<appId>/<workspaceId>/local_<id>/.claude/projects/<slug>
      let projectName = basename(dirPath)
      const resolvedBase = resolve(desktopBase)
      if (resolved.startsWith(resolvedBase + sep) || resolved.startsWith(resolvedBase + '/')) {
        const rel = resolved.slice(resolvedBase.length + 1)
        const parts = rel.split(/[/\\]/)
        // parts = [appId, workspaceId, local_sessionId, .claude, projects, slug]
        const [appId, workspaceId, sessionId, configDir, projectsDir] = parts
        if (
          parts.length >= 6 &&
          appId &&
          workspaceId &&
          sessionId?.startsWith('local_') &&
          configDir === '.claude' &&
          projectsDir === 'projects'
        ) {
          const workspaceDir = join(resolvedBase, appId, workspaceId)
          const spaceName = yield* resolveCoworkSpaceNameEffect(workspaceDir, sessionId, context)
          if (spaceName) projectName = spaceName
        }
      }

      sources.push({
        path: dirPath,
        project: projectName,
        provider: 'claude',
        sourceId: desktopSourceId,
        sourceLabel: 'Claude Desktop',
        sourcePath: desktopBase,
        sourceKind: 'claude-desktop',
      })
    }
  }

  return sources
})

export const claude: Provider = {
  name: 'claude',
  displayName: 'Claude',

  modelDisplayName(model: string): string {
    return getShortModelName(model)
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  // Each config dir's `projects/` subdir is what discoverSessions readdir's,
  // plus the Claude Desktop sessions base. Resolved via the same helpers so a
  // CLAUDE_CONFIG_DIR(S) override is reflected exactly.
  async probeRoots(): Promise<ProbeRoot[]> {
    const dirs = await getClaudeConfigDirs()
    const roots: ProbeRoot[] = dirs.map(dir => ({ path: join(dir, 'projects'), label: 'projects' }))
    roots.push(...getDesktopSessionsDirs().map(path => ({ path, label: 'desktop' })))
    return roots
  },

  discoverSessionsEffect: discoverClaudeSessionsEffect,

  async discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
    // Compatibility edge for callers that have not moved to Effect.
    // eslint-disable-next-line no-restricted-syntax
    return Effect.runPromise(discoverClaudeSessionsEffect(context))
  },

  createSessionParser(): SessionParser {
    return {
      async *parse() {},
    }
  },
}
