import { Effect } from 'effect'
import { homedir } from 'os'
import { join } from 'path'

import { type AppPaths, overrideFor, platformFor } from '../../env.js'
import { getShortModelName } from '../models.js'
import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import {
  createSqliteSessionParser,
  discoverSqliteSessionsEffect,
  OPENCODE_FAMILY_1X,
  OPENCODE_FAMILY_2X,
  type SqliteProviderConfig,
} from './opencode-family-sqlite.js'
import { createOpenCodeFileSessionParser, discoverOpenCodeFileSessionsEffect } from './opencode-file-parser.js'
import type { ProbeRoot, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

function getDataDir(dataDir?: string, paths?: AppPaths): string {
  // Test seam: createOpenCodeProvider(tmpDir) points at a base dir that still
  // gets the 'opencode' subdirectory appended, preserving existing fixtures
  // (tmpDir/opencode/opencode*.db and tmpDir/opencode/storage/...).
  if (dataDir) return join(dataDir, 'opencode')

  // Production override for OpenCode-compatible forks/renames (e.g. MiMoCode at
  // ~/.local/share/mimocode). This is the EXACT data directory — no 'opencode'
  // suffix — so a fork writing <dir>/<prefix>*.db or <dir>/storage/... is found
  // instead of silently yielding zero sessions. (issue #617)
  // Snapshot lookup (`overrideFor`), seam's own truthy check kept: a defined
  // empty override falls through to the XDG default exactly as `''` did.
  const override = overrideFor(paths, 'OPENCODE_DATA_DIR')
  if (override) return override

  // Default: $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
  // `??` parity: the snapshot reports `null` for unset (never `''`), and an
  // empty `XDG_DATA_HOME` still joins as the relative 'opencode'.
  const base = platformFor(paths).xdgDataHome ?? join(homedir(), '.local', 'share')
  return join(base, 'opencode')
}

/// Exported as OpenCode's own declaration of which schema generations it may be
/// read as — the seam ADR 0006 wants checkable, so a test can assert the list
/// without reading this file as text.
export function getSqliteConfig(dataDir?: string, paths?: AppPaths): SqliteProviderConfig {
  return {
    providerName: 'opencode',
    displayName: 'OpenCode',
    dbDir: getDataDir(dataDir, paths),
    // Truthy check (not `??`): an empty-string `OPENCODE_DB_PREFIX` must fall
    // back to 'opencode'. With `??`, '' survives as the prefix and
    // `discoverSqliteSessions` matches every '*.db' file (filename.startsWith('')
    // is always true), sweeping unrelated DBs into discovery. Aligns with
    // `OPENCODE_DATA_DIR`'s truthy handling above, and makes behavior identical
    // for unset vs empty — which matches the env fingerprint, since
    // `computeEnvFingerprint` collapses both to 'OPENCODE_DB_PREFIX='. (issue #617)
    // `||` against the snapshot keeps that: `''` is a DEFINED value there too
    // (the resolver records raw strings), and it must reach the same default.
    dbFilePrefix: overrideFor(paths, 'OPENCODE_DB_PREFIX') || 'opencode',
    // OpenCode's own migration policy, declared here rather than inside the
    // shared reader: 2.x is preferred, and the 1.x tables stay declared because
    // 2.x FREEZES them at the upgrade, so a DB carries both and a session that
    // never migrated is still read where its rows live. Most-preferred first.
    generations: [OPENCODE_FAMILY_2X, OPENCODE_FAMILY_1X],
  }
}

export function createOpenCodeProvider(dataDir?: string, paths?: AppPaths): Provider {
  const sqliteConfig = getSqliteConfig(dataDir, paths)
  const resolvedDataDir = getDataDir(dataDir, paths)
  const discoverEffect = (context?: ProviderScanContext) =>
    Effect.gen(function* () {
      const fileSessions = yield* discoverOpenCodeFileSessionsEffect(resolvedDataDir, 'opencode', context)
      const sqliteSessions = yield* discoverSqliteSessionsEffect(sqliteConfig, context)
      return [...fileSessions, ...sqliteSessions]
    })

  return {
    name: 'opencode',
    displayName: 'OpenCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // OpenCode migrated from file-based JSON (storage/session/*.json) to a
    // SQLite DB (opencode.db). After an in-place upgrade, legacy JSON files
    // remain on disk while all new data flows into the SQLite DB. Merge both
    // sources so migrated installs keep reporting legacy sessions AND pick up
    // current SQLite data. Dedup is handled per-message in createSessionParser
    // via seenKeys (keyed by `${provider}:${sessionId}:${messageId}`).
    // Both the legacy JSON store (storage/session/*.json) and the SQLite DB
    // (opencode*.db) live under this one data dir, resolved via OPENCODE_DATA_DIR
    // or XDG_DATA_HOME the same way discoverSessions does.
    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: resolvedDataDir, label: 'data' }]
    },

    discoverSessionsEffect(context?: ProviderScanContext) {
      return discoverEffect(context)
    },

    // Remove after external callers use discoverSessionsEffect.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing(paths)
      if (source.path.endsWith('.json')) {
        return createOpenCodeFileSessionParser(source, seenKeys, resolvedDataDir, 'opencode', pricing, context)
      }
      // `paths` threads straight through to the shared reader's verbose gate:
      // one trailing seam slot, no second override argument. A caller that
      // omitted it (`kilo-code.ts`) resolves `appPaths()` there instead — the
      // same lookup, at the reader rather than at the root.
      return createSqliteSessionParser(source, seenKeys, sqliteConfig, paths, pricing, context)
    },
  }
}

export const opencode = createOpenCodeProvider()
