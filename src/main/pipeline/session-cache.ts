import { createHash, randomBytes } from 'crypto'
import { Effect, Semaphore } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import { readFileSync, unlinkSync } from 'fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'

import type { CachedCall, CachedFile, FileFingerprint } from '../../shared/schemas/session-cache.js'
import {
  cachedFileSchema,
  providerSectionSchema,
  type SessionCache,
  sessionCacheSchema,
} from '../../shared/schemas/session-cache.js'
import { type AppPaths, resolveCacheDir, resolveSnapshotEnvVar, type SnapshotEnvVar } from '../env.js'

export type {
  CachedCall,
  CachedFile,
  CachedTurn,
  CachedUsage,
  FileFingerprint,
  ProviderSection,
  SessionCache,
} from '../../shared/schemas/session-cache.js'

// ── Constants ──────────────────────────────────────────────────────────

// v5: kiro joined the costUSD pass-through allowlist (credit-based pricing).
// Cached kiro entries from v4 carry costUSD: undefined and would keep being
// re-priced from estimated tokens forever, since historical session files
// never change. Bump forces a one-time re-parse so metered credit costs land.
// v6: per-turn `prRefs` capture for turn-level PR spend attribution. Existing
// cache turns carry no prRefs; bumping forces a one-time re-parse so surviving
// transcripts populate the field. (Daily-cache versioning is untouched.)
// v7: sidechain->parent linkage - per-turn `spawnToolUseIds`, per-file
// `parentSessionId` / `agentSpawnLinks` - so subagent spend folds into the parent
// turn's PR set. v6 never shipped, so users cross v5->v7 in a single combined bump.
// INVARIANT: a version bump must extend `PRIOR_CACHE_VERSIONS` (the adoption path
// below) to EVERY prior version that can still exist on disk, or expired-PR
// history from the immediately preceding build silently vanishes.
export const CACHE_VERSION = 7

// The cache filename is version-suffixed so different binaries (e.g. an old
// launchd menubar on a prior release and a newer desktop app) each own a
// distinct file and can never clobber each other's incompatible schema. Bumping
// CACHE_VERSION automatically mints a fresh filename, superseding the migration
// dance the legacy unversioned file used to need.
const CACHE_FILE = `session-cache.v${CACHE_VERSION}.json`
// The pre-versioning filename. Never written or deleted anymore — old binaries
// still own it. On first load we adopt-copy it once (see loadCache) when the
// versioned file is absent and the legacy file's version matches ours.
const LEGACY_CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000

export const PROVIDER_ENV_VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR'],
  codewhale: ['CODEWHALE_HOME'],
  codex: ['CODEX_HOME'],
  hermes: ['HERMES_HOME'],
  'lingtai-tui': ['LINGTAI_HOME', 'LINGTAI_TUI_HOME', 'LINGTAI_TUI_GLOBAL_DIR'],
  droid: ['FACTORY_DIR'],
  cursor: ['XDG_DATA_HOME'],
  'cursor-agent': ['XDG_DATA_HOME'],
  opencode: ['XDG_DATA_HOME', 'OPENCODE_DATA_DIR', 'OPENCODE_DB_PREFIX'],
  goose: ['XDG_DATA_HOME'],
  crush: ['XDG_DATA_HOME'],
  warp: ['WARP_DB_PATH'],
  antigravity: ['WATCHTOWER_CACHE_DIR'],
  qwen: ['QWEN_DATA_DIR'],
  'ibm-bob': ['XDG_CONFIG_HOME'],
  quickdesk: ['QUICKWORK_HOME'],
  kimicode: ['KIMI_CODE_HOME'],
}

// Names of providers whose cache entries are never evicted when source files
// disappear — they are preserved so month-to-date totals never drop.
export const DURABLE_PROVIDER_NAMES: ReadonlySet<string> = new Set(['copilot'])

// Estimated-cost surfacing (#639): providers that set `costIsEstimated` carry a
// `-est-cost` suffix (or a new entry) so their already-cached sessions reparse
// once and the flag lands, instead of silently reading as measured. Copilot
// needs no suffix: the cli-shutdown-cost-v1 bump below already forces its one
// re-parse, which lands the flag too, and durable orphans now survive
// fingerprint changes (the carry-forward in getOrCreateProviderSection).
export const PROVIDER_PARSE_VERSIONS: Record<string, string> = {
  // rich-session-capture-v1: parse-time capture of per-turn gitBranch, per-call
  // LOC deltas / interruptions / userModified / toolErrors, and session-level
  // title / prLinks / isSidechain. Forces one re-parse so cached sessions gain
  // the new optional fields.
  claude: 'advisor-usage-v1-skills-rich-capture-v1-cross-provider-pr-v1',
  cline: 'worktree-project-grouping-v1',
  codewhale: 'aggregate-session-v1-est-cost',
  // Bump when the Codex parser changes attribution so unchanged, already-cached
  // session files re-parse (session-cache.json serves them without invoking the
  // provider parser otherwise). Covers native mcp_tool_call_end (#513) and
  // CLI-wrapped `mcp-cli call` (#478) MCP attribution.
  // rich-session-capture-v1: per-call LOC deltas + editFailed from
  // patch_apply_end. (The codex-results.json CODEX_CACHE_VERSION is bumped in
  // lockstep so the pre-session-cache layer re-parses too.)
  codex: 'mcp-attribution-v2-est-cost-rich-capture-v1-cross-provider-pr-v1',
  cursor: 'composer-anchored-crediting-v1-est-cost',
  'cursor-agent': 'workspaceless-transcript-v1',
  // cli-shutdown-cost-v1: the `session.shutdown` rollup became the only source
  // of input/cache tokens for a Copilot CLI session.
  // skills: per-call skill attribution.
  // session-store-v1: the CLI's own `~/.copilot/session-store.db` is now a
  // telemetry source, and its per-request rows take precedence over the
  // shutdown rollup for any (session, model) they cover. That precedence is
  // decided INSIDE the parser, by a provider-lifetime set the store parser
  // populates — so a turn served straight from this cache keeps its rollup and
  // the skip never runs, double-counting the CLI's input and cache tokens.
  // The bump forces the one-time re-parse that makes the skip take effect.
  copilot: 'cli-shutdown-cost-v1-skills-session-store-v1',
  grok: 'estimated-cost-v1',
  hermes: 'reasoning-output-accounting-v1-est-cost',
  'lingtai-tui': 'token-ledger-registry-activity-v3',
  'ibm-bob': 'worktree-project-grouping-v1',
  kiro: 'ide-parsing-v1-est-cost',
  quickdesk: 'emf-sqlite-v2-est-cost',
  kimicode: 'wire-usage-v1-est-cost',
  'kilo-code': 'worktree-project-grouping-v1',
  'roo-code': 'worktree-project-grouping-v1',
  warp: 'worktree-project-grouping-v1-est-cost',
  antigravity: 'worktree-project-grouping-v5',
}

// ── Cache Dir ──────────────────────────────────────────────────────────

function getCacheDir(): string {
  return resolveCacheDir()
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), LEGACY_CACHE_FILE)
}

/** Absolute path of the active (version-suffixed) session cache file. */
export function sessionCachePath(): string {
  return getCachePath()
}

// ── Env Fingerprint ────────────────────────────────────────────────────

/**
 * The per-provider env fingerprint: which vars a provider's cached parse depends
 * on, so a config change invalidates its cache entries.
 *
 * Each var now resolves through `env.ts:ENV_VAR_SOURCES` — the one inventory of
 * which snapshot source answers a given name — instead of reading `process.env`
 * directly, so a threaded `AppPaths` record moves the hash with the seam it
 * fingerprints. That was the hard precondition for threading records into the
 * provider seams: while this function read the ambient env, a snapshot-driven
 * config change would change what the provider parses without invalidating its
 * cached rows.
 *
 * `PROVIDER_ENV_VARS` stays as the per-provider LIST (which vars this provider
 * depends on) and is now covered by the snapshot's var union, pinned by
 * `tests/session-cache-env-fingerprint.test.ts`; the untyped `v as SnapshotEnvVar`
 * is safe only because that test fails if a name is not in the inventory.
 *
 * ONE deliberate divergence from the pre-snapshot hash: the two FIELD-shaped vars
 * — `WATCHTOWER_CACHE_DIR` (antigravity) and `CODEX_HOME` (codex) — resolve to
 * the snapshot's RESOLVED field, so they hash the effective value rather than
 * `''` when the env var is unset. That costs those two providers exactly one
 * re-parse on upgrade, and it is the point: keeping `''` would let a threaded
 * `cacheDir` / `codexHome` change what the seam reads while the fingerprint stood
 * still. Every other var is override- or platform-shaped, so it still hashes `''`
 * when unset and no other cached row moves.
 */
export function computeEnvFingerprint(provider: string, paths?: AppPaths): string {
  const vars = PROVIDER_ENV_VARS[provider] ?? []
  const parts = vars.map(v => `${v}=${resolveSnapshotEnvVar(v as SnapshotEnvVar, paths) ?? ''}`)
  const parseVersion = PROVIDER_PARSE_VERSIONS[provider]
  if (parseVersion) parts.push(`parser=${parseVersion}`)
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

// ── Load / Save ────────────────────────────────────────────────────────

export function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, providers: {}, complete: false }
}

/** A cache is warm only when a full scan finished against it. Empty-but-marked
 *  (a machine with no sessions) is complete; present-but-unmarked (an interrupted
 *  cold start, or a pre-marker cache) is NOT — it is still cold. */
export function isCacheComplete(cache: SessionCache): boolean {
  return cache.complete === true
}

/**
 * Whether a provider section predates the provider-neutral PR-evidence
 * capture and must fully re-parse its present sources once. The scan stamps
 * `prEvidenceV1` when the pass settles, so this fires exactly once per
 * provider on installs whose cache was written by an older build. The
 * re-parse reuses the UNCHANGED env fingerprint with a `modified` verdict,
 * so the ledger clean-replaces each source instead of duplicating rows.
 */
export function sectionNeedsPrEvidenceReparse(section: { prEvidenceV1?: boolean }): boolean {
  return section.prEvidenceV1 !== true
}

/** On-disk cache versions historically passed these optional flags through
 * unchecked. Normalize that envelope drift while keeping the shared in-memory
 * contract strict. The inner field schema comes from the authoritative
 * provider/session schemas, so requiredness and decoded flag types stay aligned. */
function normalizeOptionalFlag<
  S extends Schema.Constraint & { readonly Type: boolean | undefined; readonly Encoded: boolean | undefined },
>(field: Schema.mutableKey<S>, normalize: (value: unknown) => boolean) {
  return Schema.mutableKey(
    Schema.optional(Schema.Unknown).pipe(
      Schema.decodeTo(field.schema, {
        decode: SchemaGetter.transform((value: unknown | undefined) =>
          value === undefined ? undefined : normalize(value),
        ),
        encode: SchemaGetter.transform((value: boolean | undefined) => value),
      }),
    ),
  )
}

const providerSectionCacheSchema = providerSectionSchema.mapFields(fields => ({
  ...fields,
  durable: normalizeOptionalFlag(fields.durable, value => Boolean(value)),
  prEvidenceV1: normalizeOptionalFlag(fields.prEvidenceV1, value => value === true),
}))

/** Legacy on-disk flag codec. Unknown keys still strip, while valid cached
 * facts survive old malformed envelope flags until the next write normalizes
 * those flags. Retire only with a cache version/support cutoff. */
const sessionCacheFileSchema = sessionCacheSchema.mapFields(fields => ({
  ...fields,
  providers: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(providerSectionCacheSchema))),
  complete: normalizeOptionalFlag(fields.complete, value => value === true),
}))

function decodeCachedFile(value: unknown): CachedFile | null {
  const decoded = Schema.decodeUnknownResult(cachedFileSchema)(value)
  return decoded._tag === 'Success' ? decoded.success : null
}

function decodeCache(value: unknown): SessionCache | null {
  const decoded = Schema.decodeUnknownResult(sessionCacheFileSchema)(value)
  if (decoded._tag === 'Failure' || decoded.success.version !== CACHE_VERSION) return null
  return decoded.success
}

// Every prior versioned cache file that can still exist on disk from a shipped or
// dev build, NEWEST first. On a bump we adopt the newest one present: its
// expired-source PR orphans (transcripts since deleted) hold attributable spend
// that can never be re-parsed, and each newer version already carried the older
// versions' orphans forward, so the newest is a superset. INVARIANT: a
// CACHE_VERSION bump MUST extend this list to every prior version that can still
// exist on disk, or that history silently vanishes. (v5 was missed on the 5->6
// bump; v6 on the 6->7 bump; both are listed here.)
const PRIOR_CACHE_VERSIONS = [6, 5] as const

function priorCacheFile(version: number): string {
  return `session-cache.v${version}.json`
}

// Lightweight top-level check: a specific prior-version cache envelope with a
// providers object. Files are validated per-entry in adoptPriorCache so one
// corrupt entry cannot drop every valid expired-transcript PR session.
function isCacheEnvelope(
  raw: unknown,
  version: number,
): raw is { version: number; providers: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['version'] === version && !!o['providers'] && typeof o['providers'] === 'object' && !Array.isArray(o['providers'])
  )
}

const fromPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: operation, catch: error => (error instanceof Error ? error : new Error(String(error))) })

export const loadCacheEffect = Effect.fn('loadCacheEffect')(function* (): Effect.fn.Return<SessionCache, Error> {
  const current = yield* fromPromise(async () => {
    const raw = await readFile(getCachePath(), 'utf-8')
    return decodeCache(JSON.parse(raw))
  }).pipe(Effect.catch(() => Effect.succeed(null)))
  return current ?? (yield* afterMissingVersionedCacheEffect())
})

/** Promise boundary retained for callers that have not moved to Effect yet. */
export function loadCache(): Promise<SessionCache> {
  return Effect.runPromise(loadCacheEffect())
}

// The current versioned file is absent/unreadable. Prefer adopting the newest
// prior versioned file's expired-source PR orphans (v6 before v5); failing that,
// fall back to the legacy unversioned file. Either way the versioned file is
// minted on the next save.
const afterMissingVersionedCacheEffect = Effect.fn('afterMissingVersionedCacheEffect')(function* (): Effect.fn.Return<
  SessionCache,
  Error
> {
  const prior = yield* adoptNewestPriorCacheEffect()
  if (prior) return prior
  // validateCache requires version === CACHE_VERSION, so a different-version
  // legacy file is ignored (left intact). We copy it into the versioned file once
  // via saveCache; the legacy file is never modified.
  return yield* adoptLegacyCacheEffect()
})

const adoptLegacyCacheEffect = Effect.fn('adoptLegacyCacheEffect')(function* (): Effect.fn.Return<SessionCache, Error> {
  const decoded = yield* fromPromise(async () =>
    decodeCache(JSON.parse(await readFile(getLegacyCachePath(), 'utf-8'))),
  ).pipe(Effect.catch(() => Effect.succeed(null)))
  if (!decoded) return emptyCache()
  yield* saveCacheEffect(decoded).pipe(Effect.catch(() => Effect.succeed(false)))
  return decoded
})

const adoptPriorCacheEffect = (version: number): Effect.Effect<SessionCache | null, Error> =>
  fromPromise(async () => {
    const raw = await readFile(join(getCacheDir(), priorCacheFile(version)), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isCacheEnvelope(parsed, version)) return null
    const migrated: SessionCache = { version: CACHE_VERSION, providers: {}, complete: false }
    for (const [provider, section] of Object.entries(parsed.providers)) {
      if (!section || typeof section !== 'object') continue
      const rawFiles = (section as Record<string, unknown>)['files']
      const files: Record<string, CachedFile> = {}
      if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
        for (const [path, file] of Object.entries(rawFiles as Record<string, unknown>)) {
          const decodedFile = decodeCachedFile(file)
          if (
            decodedFile?.prLinks?.length &&
            !(await stat(path).then(
              () => true,
              () => false,
            ))
          )
            files[path] = decodedFile
        }
      }
      migrated.providers[provider] = {
        envFingerprint: computeEnvFingerprint(provider),
        files,
        ...((section as Record<string, unknown>)['durable'] ? { durable: true } : {}),
      }
    }
    return migrated
  }).pipe(Effect.catch(() => Effect.succeed(null)))

const adoptNewestPriorCacheEffect = Effect.fn('adoptNewestPriorCacheEffect')(function* (): Effect.fn.Return<
  SessionCache | null,
  Error
> {
  let merged: SessionCache | null = null
  for (const version of [...PRIOR_CACHE_VERSIONS].sort((a, b) => a - b)) {
    const adopted = yield* adoptPriorCacheEffect(version)
    if (!adopted) continue
    if (!merged) {
      merged = adopted
      continue
    }
    for (const [provider, section] of Object.entries(adopted.providers)) {
      const existing = merged.providers[provider]
      if (!existing) merged.providers[provider] = section
      else {
        Object.assign(existing.files, section.files)
        if (section.durable) existing.durable = true
      }
    }
  }
  return merged
})

export const saveCacheEffect = Effect.fn('saveCacheEffect')(function* (
  cache: SessionCache,
  verifyStillOwner?: () => Effect.Effect<boolean, Error>,
): Effect.fn.Return<boolean, Error> {
  const dir = getCacheDir()
  yield* fromPromise(() => mkdir(dir, { recursive: true }))
  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  delete (cache as { _dirty?: boolean })._dirty
  const payload = JSON.stringify(cache)
  const published = yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      fromPromise(() => open(tempPath, 'w', 0o600)),
      handle =>
        fromPromise(async () => {
          await handle.writeFile(payload, { encoding: 'utf-8' })
          await handle.sync()
        }).pipe(Effect.uninterruptible),
      handle => fromPromise(() => handle.close()),
    )
    if (verifyStillOwner && !(yield* verifyStillOwner())) return false
    let renamed = false
    for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
      const result = yield* Effect.uninterruptible(fromPromise(() => rename(tempPath, finalPath))).pipe(
        Effect.map(() => true),
        Effect.catch(error => {
          const code = (error as NodeJS.ErrnoException).code
          return code === 'EPERM' || code === 'EBUSY' ? Effect.succeed(false) : Effect.fail(error as Error)
        }),
      )
      renamed = result
      if (!renamed) {
        if (attempt === 2) return yield* Effect.fail(new Error('session cache rename failed'))
        yield* Effect.sleep(`${10 * (attempt + 1)} millis`)
      }
    }
    return true
  }).pipe(Effect.ensuring(fromPromise(() => unlink(tempPath)).pipe(Effect.catch(() => Effect.void))))
  return published
})

/** Promise edge for unmigrated consumers. */
export function saveCache(cache: SessionCache, verifyStillOwner?: () => Promise<boolean>): Promise<boolean> {
  return Effect.runPromise(saveCacheEffect(cache, verifyStillOwner ? () => fromPromise(verifyStillOwner) : undefined))
}

// ── File Fingerprinting ────────────────────────────────────────────────
//
// Fingerprints cover the source's transcript file only. Providers that keep
// metadata in a companion file (kiro CLI: credits in `<id>.json` next to the
// `.jsonl`; kiro v2: modelId in `session.json` next to `messages.jsonl`) have
// a blind spot: a parse that races the companion write caches the turn with
// fallback values, and if the transcript never changes again (a session's
// final turn) the entry never invalidates. Mid-session turns self-heal since
// append-only transcripts keep changing. Fixing this properly means
// multi-file fingerprints per source.

export function fingerprintFile(filePath: string): Promise<FileFingerprint | null> {
  return Effect.runPromise(fingerprintFileEffect(filePath))
}

export const fingerprintFileEffect = (filePath: string): Effect.Effect<FileFingerprint | null, Error> =>
  Effect.gen(function* () {
    const paths = [filePath]
    const hashIdx = filePath.indexOf('#')
    if (hashIdx > 0) paths.push(filePath.slice(0, hashIdx))
    const colonIdx = filePath.lastIndexOf(':')
    if (colonIdx > 0) paths.push(filePath.slice(0, colonIdx))
    for (const path of [...new Set(paths)]) {
      const result = yield* fromPromise(() => stat(path)).pipe(
        Effect.map(s => ({ dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size })),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (result) return result
    }
    return null
  })

// ── Reconciliation ─────────────────────────────────────────────────────

export type ReconcileAction =
  { action: 'unchanged' } | { action: 'appended'; readFromOffset: number } | { action: 'modified' } | { action: 'new' }

export function reconcileFile(current: FileFingerprint, cached: CachedFile | undefined): ReconcileAction {
  if (!cached) return { action: 'new' }

  const fp = cached.fingerprint

  if (
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    fp.mtimeMs === current.mtimeMs &&
    fp.sizeBytes === current.sizeBytes
  ) {
    return { action: 'unchanged' }
  }

  if (
    cached.lastCompleteLineOffset !== undefined &&
    // Defensive: never resume past the file's current end. A truncate-then-regrow
    // can leave the cached offset stranded beyond live bytes; reading from there
    // would silently drop the appended tail, so fall back to a full re-parse.
    cached.lastCompleteLineOffset <= current.sizeBytes &&
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    current.sizeBytes > fp.sizeBytes
  ) {
    return { action: 'appended', readFromOffset: cached.lastCompleteLineOffset }
  }

  return { action: 'modified' }
}

// ── Dedup Merge ────────────────────────────────────────────────────────
// When appending incremental data, streaming Claude messages can re-emit
// the same dedup key with updated usage. Merge by key: keep the earliest
// timestamp, take incoming usage/tools/bashCommands/skills (latest wins).

export function mergeCallByDedupKey(existing: CachedCall, incoming: CachedCall): CachedCall {
  return {
    ...incoming,
    timestamp: existing.timestamp < incoming.timestamp ? existing.timestamp : incoming.timestamp,
  }
}

// ── Temp Cleanup ───────────────────────────────────────────────────────

export const cleanupOrphanedTempFilesEffect = Effect.fn('cleanupOrphanedTempFilesEffect')(
  function* (): Effect.fn.Return<void, Error> {
    const dir = getCacheDir()
    const entries = yield* fromPromise(() => readdir(dir)).pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const now = yield* Effect.clockWith(clock => clock.currentTimeMillis)
    const prefix = `${CACHE_FILE}.`
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
      const fullPath = join(dir, entry)
      const s = yield* fromPromise(() => stat(fullPath)).pipe(Effect.catch(() => Effect.succeed(null)))
      if (s && now - s.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
        yield* fromPromise(() => unlink(fullPath)).pipe(Effect.catch(() => Effect.void))
      }
    }
  },
)

export function cleanupOrphanedTempFiles(): Promise<void> {
  return Effect.runPromise(cleanupOrphanedTempFilesEffect())
}

// ── Hydration Lock ─────────────────────────────────────────────────────
//
// Advisory, cross-process coordination for the expensive cold hydration. When
// two live processes (e.g. an old launchd menubar and the desktop app) both
// cold-start against the same cache dir, without this they each parse full
// history and race their writes. The first to arrive creates the lock and
// hydrates; a second live process waits for release, then reads the now-warm
// cache instead of re-parsing. It is strictly an optimization: on any
// uncertainty we proceed with the parse, so it can never wedge a cold start.

const HYDRATION_LOCK_FILE = 'hydrating.lock'
const LOCK_FRESH_MS = 15 * 60_000
const LOCK_WAIT_MAX_MS = 10 * 60_000
const LOCK_POLL_MS = 250
const coldHydrationPermit = Semaphore.makeUnsafe(1)

type LockRecord = { pid: number; at: number }
export type HydrationHandle = { waited: boolean; release: () => Promise<void> }
export type HydrationHandleEffect = { waited: boolean; release: Effect.Effect<void, Error> }

function lockPath(): string {
  return join(getCacheDir(), HYDRATION_LOCK_FILE)
}

// Our own pid never counts as a foreign holder: a same-process lock is either
// re-entrant or leaked, and waiting on ourselves risks a self-hang. Cross-process
// coordination is the only thing this lock is for. EPERM means the pid exists but
// belongs to another user — still alive.
function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readLockRecordEffect = (): Effect.Effect<LockRecord | null, Error> =>
  fromPromise(async () => {
    const parsed = JSON.parse(await readFile(lockPath(), 'utf-8')) as Partial<LockRecord>
    return typeof parsed?.pid === 'number' && typeof parsed?.at === 'number' ? { pid: parsed.pid, at: parsed.at } : null
  }).pipe(Effect.catch(() => Effect.succeed(null)))

const writeOurLockEffect = (): Effect.Effect<boolean, Error> =>
  Effect.uninterruptible(
    fromPromise(async () => {
      await mkdir(getCacheDir(), { recursive: true })
      const handle = await open(lockPath(), 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: 'utf-8' })
      } finally {
        await handle.close()
      }
      return true
    }).pipe(Effect.catch(() => Effect.succeed(false))),
  )

const removeOurLockEffect = (): Effect.Effect<void, never> =>
  Effect.uninterruptible(
    readLockRecordEffect().pipe(
      Effect.flatMap(current =>
        current?.pid === process.pid
          ? fromPromise(() => unlink(lockPath())).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    ),
  ).pipe(Effect.catch(() => Effect.void))

// Synchronous variant for the signal path: a handler can't await, so read + unlink
// synchronously. Only unlinks a lock we actually own.
function removeOurLockSync(): void {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf-8')) as Partial<LockRecord>
    if (parsed?.pid === process.pid) unlinkSync(lockPath())
  } catch {
    /* best-effort; nothing to clean or already gone */
  }
}

// Arm once, only while we hold the lock: on a catchable termination (Ctrl-C, or a
// SIGTERM from a parent) clean our lock before dying so a killed cold parse leaves
// no leftover. SIGKILL can't be caught, so that path still relies on the next cold
// start's stale-lock takeover. process.once + re-raise preserves the default exit.
let signalCleanupArmed = false
function armSignalCleanup(): void {
  if (signalCleanupArmed) return
  signalCleanupArmed = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      removeOurLockSync()
      process.kill(process.pid, sig)
    })
  }
}

const noopHydrationEffect: HydrationHandleEffect = { waited: false, release: Effect.void }

/**
 * Coordinate a cold hydration. Pass `isCold = true` only when the on-disk cache
 * is empty (a genuine full parse is imminent). Returns a handle:
 *  - `waited: true`  → another live process was hydrating; we waited for it to
 *    finish (or timed out). The caller should RELOAD the cache and let its normal
 *    reconcile serve the now-warm entries instead of re-parsing. The handle's
 *    release skips the file lock and frees this process's serialization permit.
 *  - `waited: false` with a real `release` → we hold the lock; hydrate, then call
 *    `release()` in a finally.
 *  - `waited: false` with a no-op `release` → proceed with the parse unlocked
 *    (not cold, or the lock state was uncertain).
 */
export const beginColdHydrationEffect = Effect.fn('beginColdHydrationEffect')(function* (
  isCold: boolean,
): Effect.fn.Return<HydrationHandleEffect, Error> {
  if (!isCold) return noopHydrationEffect
  let ownsPermit = false
  let ownsLock = false
  let handedOff = false
  let waitedForLocalOwner = false
  const releasePermit = Effect.suspend(() => {
    if (!ownsPermit) return Effect.void
    ownsPermit = false
    return coldHydrationPermit.release(1).pipe(Effect.asVoid)
  })

  const claimLock = (): Effect.Effect<boolean, Error> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (!(yield* writeOurLockEffect())) return false
        ownsLock = true
        armSignalCleanup()
        return true
      }),
    )

  const acquire = Effect.gen(function* () {
    if (waitedForLocalOwner) return { waited: true }
    if (yield* claimLock()) return { waited: false }
    const existing = yield* readLockRecordEffect()
    const now = yield* Effect.clockWith(clock => clock.currentTimeMillis)
    if (existing && now - existing.at < LOCK_FRESH_MS && pidLooksAlive(existing.pid)) {
      const deadline = now + LOCK_WAIT_MAX_MS
      let takeover = false
      while ((yield* Effect.clockWith(clock => clock.currentTimeMillis)) < deadline) {
        yield* Effect.sleep(`${LOCK_POLL_MS} millis`)
        const current = yield* readLockRecordEffect()
        if (!current) break
        const time = yield* Effect.clockWith(clock => clock.currentTimeMillis)
        if (time - current.at >= LOCK_FRESH_MS || !pidLooksAlive(current.pid)) {
          takeover = true
          break
        }
      }
      if (takeover) {
        yield* fromPromise(() => unlink(lockPath())).pipe(Effect.catch(() => Effect.void))
        if (yield* claimLock()) return { waited: false }
      }
      return { waited: true }
    }
    yield* fromPromise(() => unlink(lockPath())).pipe(Effect.catch(() => Effect.void))
    yield* claimLock()
    return { waited: false }
  })

  return yield* Effect.uninterruptibleMask(restore => {
    const finishAcquisition = (): Effect.Effect<HydrationHandleEffect, Error> =>
      restore(acquire).pipe(
        Effect.catch(() => Effect.succeed({ waited: false })),
        Effect.map(({ waited }) => {
          let released = false
          handedOff = true
          return {
            waited,
            release: Effect.suspend(() => {
              if (released) return Effect.void
              released = true
              return (ownsLock ? removeOurLockEffect() : Effect.void).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ownsLock = false
                  }).pipe(Effect.flatMap(() => releasePermit)),
                ),
              )
            }),
          }
        }),
        Effect.ensuring(
          Effect.suspend(() =>
            handedOff
              ? Effect.void
              : (ownsLock ? removeOurLockEffect() : Effect.void).pipe(Effect.ensuring(releasePermit)),
          ),
        ),
      )
    return restore(coldHydrationPermit.takeIfAvailable(1)).pipe(
      Effect.flatMap(acquired => {
        if (acquired) ownsPermit = true
        else {
          waitedForLocalOwner = true
          return restore(coldHydrationPermit.take(1)).pipe(
            Effect.flatMap(() => {
              ownsPermit = true
              return finishAcquisition()
            }),
          )
        }
        return finishAcquisition()
      }),
    )
  })
})

/** Promise edge for callers that have not migrated. */
export async function beginColdHydration(isCold: boolean): Promise<HydrationHandle> {
  const handle = await Effect.runPromise(beginColdHydrationEffect(isCold))
  return { waited: handle.waited, release: () => Effect.runPromise(handle.release) }
}
