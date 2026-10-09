import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  type AppPaths,
  appPaths,
  ENV_VAR_SOURCES,
  PROVIDER_ENV_KEYS,
  type ProviderOverrides,
  type SnapshotEnvVar,
} from '../src/main/env.js'
import {
  computeEnvFingerprint,
  PROVIDER_ENV_VARS,
  PROVIDER_PARSE_VERSIONS,
} from '../src/main/pipeline/session-cache.js'

// `session-cache.computeEnvFingerprint` is the hard precondition for threading
// `AppPaths` records into the provider seams: while it read `process.env`
// directly, a snapshot-driven config change would move what a provider parses
// WITHOUT invalidating its cached rows. It now resolves every var through
// `env.ts:ENV_VAR_SOURCES`.
//
// Two claims are pinned here, both machine-checkable rather than asserted in a
// comment:
//  1. The two inventories cannot drift. Every var `PROVIDER_ENV_VARS` names is
//     in the snapshot inventory, and every override-shaped one is a registered
//     `ProviderEnvKey` — so the fingerprint is total and an unmapped var is a
//     test failure, not a silently mis-hashed row.
//  2. A threaded record MOVES the hash. Planted values, never `process.env`
//     mutation: this file writes no env var, so nothing here depends on what
//     the host machine happens to export. The unthreaded cases read the ambient
//     value in the ASSERTION, mirroring `tests/claude-app-paths.test.ts`.
//
// The one deliberate divergence from the pre-snapshot hash is the two
// FIELD-shaped vars: `WATCHTOWER_CACHE_DIR` (antigravity) and `CODEX_HOME`
// (codex) answer with the snapshot's RESOLVED field, so they hash the effective
// value instead of `''`. That re-parses exactly those two providers' cached
// rows once on upgrade, and it is bug-prevention, not an accident.

/** Repo root, for the one case that reads a source file to check a claim. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every platform root unset — the shape `null` (never `''`) produces. */
const NO_PLATFORM = { appData: null, localAppData: null, xdgConfigHome: null, xdgDataHome: null } as const

/** A record carrying only what the case plants; the rest mirrors production. */
function pathsOf(overrides: ProviderOverrides = {}, fields: Partial<AppPaths> = {}): AppPaths {
  return { ...appPaths(), platform: NO_PLATFORM, overrides, ...fields }
}

/** Every var the fingerprint is claimed to name, across every provider. */
function allFingerprintVars(): string[] {
  return Object.values(PROVIDER_ENV_VARS).flat()
}

/**
 * The pre-snapshot formula, verbatim, as an oracle: `${var}=${raw ?? ''}` per
 * var, `parser=<version>` last, joined on NUL, sha256, first 16 hex chars.
 * `values` supplies the raw env values; omitted names are unset, exactly what
 * `process.env[v] ?? ''` produced.
 */
function legacyFingerprint(provider: string, values: Readonly<Record<string, string>> = {}): string {
  const parts = (PROVIDER_ENV_VARS[provider] ?? []).map(v => `${v}=${values[v] ?? ''}`)
  const parseVersion = PROVIDER_PARSE_VERSIONS[provider]
  if (parseVersion) parts.push(`parser=${parseVersion}`)
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

/** Every env var name the snapshot reports as a RESOLVED field. */
const FIELD_ENV_VARS = Object.entries(ENV_VAR_SOURCES)
  .filter(([, source]) => source.kind === 'field')
  .map(([name]) => name)

/** Every provider whose vars are all override- or platform-shaped (no resolved field). */
const OVERRIDE_PLATFORM_PROVIDERS = Object.entries(PROVIDER_ENV_VARS)
  .filter(([, vars]) => !vars.some(v => FIELD_ENV_VARS.includes(v)))
  .map(([provider]) => provider)

/** A value no machine exports, so a comparison cannot agree with the host. */
const plantedNeverOnThisMachine = '/watchtower-test/inert'

describe('the two inventories cannot drift (PROVIDER_ENV_VARS vs ENV_VAR_SOURCES)', () => {
  it('every var the fingerprint names is covered by the snapshot inventory', () => {
    // A var with no inventory row would resolve `undefined` and hash as `''`
    // forever — a cached row that survives any config change. This is the case
    // that makes that impossible.
    expect(allFingerprintVars().filter(name => !(name in ENV_VAR_SOURCES))).toEqual([])
  })

  it('every override-shaped fingerprint var is a registered PROVIDER_ENV_KEYS member', () => {
    // `overrideFor` is the expression a seam uses for an override var, so a var
    // the fingerprint names that is NOT a `ProviderEnvKey` has no seam-side
    // expression: it would be answered from somewhere no seam looks.
    for (const name of allFingerprintVars()) {
      if (ENV_VAR_SOURCES[name as keyof typeof ENV_VAR_SOURCES].kind !== 'override') continue
      expect(PROVIDER_ENV_KEYS, name).toContain(name)
    }
  })

  it('the fingerprint reads no env var directly (the source says so)', () => {
    // The slice's acceptance criterion, stated as a claim a future edit can
    // break: a bare `process.env` READ in this file would put the fingerprint
    // back on the ambient env, where a threaded record cannot reach it. The
    // pattern matches both accessor forms a read can take (`process.env[x]` and
    // `process.env.x`) while ignoring a prose mention of the identifier, which
    // this file's own comment legitimately contains.
    const text = readFileSync(join(repoRoot, 'src', 'main', 'pipeline', 'session-cache.ts'), 'utf8')
    expect(text).not.toMatch(/\bprocess\.env\s*(\.|\[)/)
  })
})

describe('an unset var still hashes as the empty string (byte-identity pin)', () => {
  it('an all-unset record reproduces the pre-snapshot hash exactly', () => {
    // For a provider whose vars are all override- or platform-shaped, an
    // all-unset threaded record must produce the digest the old `process.env`
    // read produced on a default install. That is what keeps every cached row
    // outside the two field-shaped providers valid across the upgrade — and the
    // provider list is derived from the inventories, so a var promoted to
    // field-shaped later moves the exclusion here instead of silently widening
    // the blast radius.
    // Every provider except the two field-shaped ones is covered here, so the
    // exclusion cannot quietly shrink.
    expect(OVERRIDE_PLATFORM_PROVIDERS).toHaveLength(Object.keys(PROVIDER_ENV_VARS).length - 2)
    for (const provider of OVERRIDE_PLATFORM_PROVIDERS) {
      expect(computeEnvFingerprint(provider, pathsOf({})), provider).toBe(legacyFingerprint(provider))
    }
  })

  it('unthreaded, the hash still matches the ambient env read it replaced', () => {
    // No record threaded: `appPaths()` resolves the same ambient values through
    // the same pure resolvers, so an uninitialized isolate is byte-identical.
    for (const provider of OVERRIDE_PLATFORM_PROVIDERS) {
      const ambient: Record<string, string> = {}
      for (const name of PROVIDER_ENV_VARS[provider] ?? []) {
        const raw = process.env[name]
        if (raw !== undefined) ambient[name] = raw
      }
      expect(computeEnvFingerprint(provider), provider).toBe(legacyFingerprint(provider, ambient))
    }
  })

  it('a defined-empty override is still a value, and still hashes as the empty string', () => {
    // The snapshot reports `''` verbatim and the fingerprint's own `?? ''` maps
    // it to the same bytes an UNSET var produces, so a machine that exports
    // `CLAUDE_CONFIG_DIR=""` keeps the rows it had. (The two are
    // indistinguishable to the hash on purpose: neither changes what the seam
    // reads — `getClaudeConfigDirs` skips both.)
    expect(computeEnvFingerprint('claude', pathsOf({ CLAUDE_CONFIG_DIR: '' }))).toBe(
      legacyFingerprint('claude', { CLAUDE_CONFIG_DIR: '' }),
    )
    expect(computeEnvFingerprint('claude', pathsOf({ CLAUDE_CONFIG_DIR: '' }))).toBe(
      computeEnvFingerprint('claude', pathsOf({})),
    )
  })
})

describe('a threaded record moves the fingerprint for the provider that reads it', () => {
  it('an override-shaped var: a planted value changes the hash', () => {
    // Planted values are ones no machine sets, so the comparison cannot
    // accidentally agree with whatever the host exports.
    const empty = computeEnvFingerprint('hermes', pathsOf({}))
    const threaded = computeEnvFingerprint('hermes', pathsOf({ HERMES_HOME: '/watchtower-test/threaded/hermes' }))
    expect(threaded).not.toBe(empty)
    // Two different planted values are two different hashes: the digest is a
    // function OF the record, not merely "different from the unthreaded one".
    expect(computeEnvFingerprint('hermes', pathsOf({ HERMES_HOME: '/watchtower-test/threaded/other' }))).not.toBe(
      threaded,
    )
    // The planted value hashes exactly what the old formula hashed for the same
    // env value, so nothing about the HASH FORMAT changed either.
    expect(threaded).toBe(legacyFingerprint('hermes', { HERMES_HOME: '/watchtower-test/threaded/hermes' }))
  })

  it('a platform-shaped var: a planted platform root changes the hash', () => {
    const empty = computeEnvFingerprint('cursor', pathsOf({}))
    const threaded = computeEnvFingerprint(
      'cursor',
      pathsOf({}, { platform: { ...NO_PLATFORM, xdgDataHome: '/watchtower-test/xdg' } }),
    )
    expect(threaded).not.toBe(empty)
    expect(threaded).toBe(legacyFingerprint('cursor', { XDG_DATA_HOME: '/watchtower-test/xdg' }))
  })

  it('a var the provider does not name cannot move that provider hash', () => {
    // `hermes` depends on `HERMES_HOME` only. Planting `WARP_DB_PATH` moves
    // warp's hash and leaves hermes' alone, which is what makes the fingerprint
    // a per-provider statement rather than a global env dump.
    expect(computeEnvFingerprint('hermes', pathsOf({ WARP_DB_PATH: '/watchtower-test/warp.db' }))).toBe(
      computeEnvFingerprint('hermes', pathsOf({})),
    )
    expect(computeEnvFingerprint('warp', pathsOf({ WARP_DB_PATH: '/watchtower-test/warp.db' }))).not.toBe(
      computeEnvFingerprint('warp', pathsOf({})),
    )
  })

  it('every var in every provider list moves that provider hash, through its own source', () => {
    // The exhaustive form of "the fingerprint follows the snapshot": for each
    // provider, plant EVERY var it names through the source the inventory says
    // answers it, and require the hash to move. A var planted in the wrong
    // place (a field var in `overrides`, say) would leave the hash alone —
    // which is exactly the bug this inventory makes impossible to hide.
    const value = '/watchtower-test/all'
    const allPlatform = { appData: value, localAppData: value, xdgConfigHome: value, xdgDataHome: value }
    for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS)) {
      const planted: Record<string, string> = {}
      for (const name of vars) {
        if (ENV_VAR_SOURCES[name as SnapshotEnvVar].kind === 'override') planted[name] = value
      }
      const fields: Partial<AppPaths> = { platform: allPlatform, cacheDir: value, codexHome: value }
      expect(computeEnvFingerprint(provider, pathsOf(planted as ProviderOverrides, fields)), provider).not.toBe(
        computeEnvFingerprint(provider, pathsOf({})),
      )
    }
  })

  it('a field-shaped var planted in the wrong source does NOT move the hash', () => {
    // The mirror of the case above, and the reason the inventory is not
    // optional bookkeeping: `CODEX_HOME` is answered by `codexHome`, so
    // `overrides: { CODEX_HOME }` is inert. Pre-slice this was indistinguishable
    // from the right answer, which is why the two lists could drift at all.
    const inert = pathsOf({ CODEX_HOME: plantedNeverOnThisMachine } as ProviderOverrides)
    expect(computeEnvFingerprint('codex', inert)).toBe(computeEnvFingerprint('codex', pathsOf({})))
  })
})

describe('field-shaped vars: the deliberate one-time re-parse', () => {
  // `WATCHTOWER_CACHE_DIR` and `CODEX_HOME` are answered by a snapshot FIELD,
  // not by a raw env read: `providers/codex.ts:createCodexProvider` reads
  // `appPaths().codexHome`, and the cache dir is `appPaths().cacheDir`. The
  // field carries the seam's own default (`~/.codex`, the boot cache dir), so
  // hashing the RESOLVED value is the only way a threaded field can invalidate
  // its rows. Rejected alternative: keep hashing `''` for an unset var, which
  // would let a record change what the seam reads while the fingerprint stood
  // still — precisely the hazard this slice exists to remove.

  it('antigravity: a threaded cacheDir changes the hash and differs from the unset-var hash', () => {
    const resolved = computeEnvFingerprint('antigravity', pathsOf({}, { cacheDir: '/watchtower-test/cache' }))
    expect(resolved).not.toBe(computeEnvFingerprint('antigravity', pathsOf({}, { cacheDir: '/watchtower-test/other' })))
    // The one-time invalidation: the pre-snapshot hash for an unset
    // `WATCHTOWER_CACHE_DIR` hashed `''`, the resolved default never does.
    expect(resolved).not.toBe(legacyFingerprint('antigravity'))
  })

  it('codex: a threaded codexHome changes the hash and differs from the unset-var hash', () => {
    const one = computeEnvFingerprint('codex', pathsOf({}, { codexHome: '/watchtower-test/codex-a' }))
    const two = computeEnvFingerprint('codex', pathsOf({}, { codexHome: '/watchtower-test/codex-b' }))
    expect(one).not.toBe(two)
    expect(one).not.toBe(legacyFingerprint('codex'))
  })

  it('only antigravity and codex name a field-shaped var, so nothing else re-parses', () => {
    // The invalidation is scoped by this list: every other provider's hash is
    // byte-identical across the upgrade, which the byte-identity block above
    // pins by derivation and this one pins by exclusion.
    expect(FIELD_ENV_VARS).toEqual(['CODEX_HOME', 'WATCHTOWER_CACHE_DIR'])
    const affected = Object.entries(PROVIDER_ENV_VARS)
      .filter(([, vars]) => vars.some(v => FIELD_ENV_VARS.includes(v)))
      .map(([provider]) => provider)
      .sort()
    expect(affected).toEqual(['antigravity', 'codex'])
  })
})
