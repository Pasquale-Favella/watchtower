import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, it } from 'vitest'

import { type AppPaths, appPaths, type PlatformPaths, type ProviderOverrides } from '../src/main/env.js'
import { createCrushProvider, crush, getRegistryPath } from '../src/main/pipeline/providers/crush.js'
import { createOpenCodeProvider, opencode } from '../src/main/pipeline/providers/opencode.js'
import type { Provider } from '../src/main/pipeline/providers/types.js'

// Provider-home seams (Wave 9 rollout, step 2): `OPENCODE_DATA_DIR` /
// `XDG_DATA_HOME` / `OPENCODE_DB_PREFIX` and `CRUSH_GLOBAL_DATA` /
// `LOCALAPPDATA` / `XDG_DATA_HOME`. Every case threads an `AppPaths` record
// built by spread — ZERO `process.env` mutation — and the unthreaded cases read
// the ambient value in the assertion. The pure resolvers behind the snapshot
// are pinned in `tests/env.test.ts`; what is covered here is the seam
// composition: the seam keeps its OWN normalization on top of the snapshot.
const NO_PLATFORM: PlatformPaths = {
  appData: null,
  localAppData: null,
  xdgConfigHome: null,
  xdgDataHome: null,
}

/** The record the seams receive as their trailing `paths` argument: the ambient
 * snapshot with ONLY the two fields a provider reads replaced. */
function pathsWith(overrides: ProviderOverrides, platform: PlatformPaths): AppPaths {
  return { ...appPaths(), overrides, platform }
}

const isWindows = process.platform === 'win32'
const posixShare = () => join(homedir(), '.local', 'share')
const windowsLocal = () => join(homedir(), 'AppData', 'Local')

/** The platform branch of `getRegistryPath` — the side that must win once
 *  `CRUSH_GLOBAL_DATA` is absent or falsy. Mirrored here on purpose: the point
 *  of those cases is that the override did NOT take the branch. */
function platformBranch(localAppData: string | null, xdgDataHome: string | null): string {
  const base = isWindows ? (localAppData ?? windowsLocal()) : (xdgDataHome ?? posixShare())
  return join(base, 'crush', 'projects.json')
}

async function probeRootPath(provider: Provider): Promise<string> {
  if (!provider.probeRoots) throw new Error(`${provider.name} does not expose probe roots`)
  const roots = await provider.probeRoots()
  expect(roots).toHaveLength(1)
  return roots[0]!.path
}

/** What the two ambient `process.env` reads resolve to — the unthreaded seam's
 *  own chain, stated once so both unthreaded cases assert the same value. */
function ambientOpenCodeDataDir(): string {
  const override = process.env['OPENCODE_DATA_DIR']
  return override ? override : join(process.env['XDG_DATA_HOME'] ?? posixShare(), 'opencode')
}

describe('createOpenCodeProvider (OPENCODE_DATA_DIR / XDG_DATA_HOME seam)', () => {
  it('threaded override wins over the threaded XDG root (the fork case, issue #617)', async () => {
    const paths = pathsWith({ OPENCODE_DATA_DIR: '/fork/mimocode' }, { ...NO_PLATFORM, xdgDataHome: '/xdg/data' })
    // The override is the EXACT dir: no 'opencode' suffix, unlike the XDG branch.
    await expect(probeRootPath(createOpenCodeProvider(undefined, paths))).resolves.toBe('/fork/mimocode')
  })

  it('threaded XDG root is honored when no override is present', async () => {
    const paths = pathsWith({}, { ...NO_PLATFORM, xdgDataHome: '/xdg/data' })
    await expect(probeRootPath(createOpenCodeProvider(undefined, paths))).resolves.toBe(join('/xdg/data', 'opencode'))
  })

  it('a null platform root falls back to the homedir default (null parity with an unset env var)', async () => {
    // `resolvePlatformPaths` reports unset as `null`, never `''`: the seam's `??`
    // must skip it exactly as it skipped `process.env[...] === undefined`.
    const paths = pathsWith({}, NO_PLATFORM)
    await expect(probeRootPath(createOpenCodeProvider(undefined, paths))).resolves.toBe(join(posixShare(), 'opencode'))
  })

  it('a defined-empty override is falsy and falls through to the XDG root (truthy check kept)', async () => {
    // The snapshot records `''` VERBATIM (a defined value, not "unset"): the
    // seam's own `if (override)` is what turns it back into the fallback.
    const paths = pathsWith({ OPENCODE_DATA_DIR: '' }, { ...NO_PLATFORM, xdgDataHome: '/xdg/data' })
    await expect(probeRootPath(createOpenCodeProvider(undefined, paths))).resolves.toBe(join('/xdg/data', 'opencode'))
  })

  it('a defined-empty XDG root still joins as the relative default (?? parity, never nulled)', async () => {
    const paths = pathsWith({}, { ...NO_PLATFORM, xdgDataHome: '' })
    await expect(probeRootPath(createOpenCodeProvider(undefined, paths))).resolves.toBe(join('', 'opencode'))
  })

  it('unthreaded resolves exactly what the two process.env reads resolved', async () => {
    await expect(probeRootPath(createOpenCodeProvider())).resolves.toBe(ambientOpenCodeDataDir())
  })

  it('the explicit dataDir test seam still wins over the snapshot', async () => {
    const paths = pathsWith({ OPENCODE_DATA_DIR: '/fork/mimocode' }, { ...NO_PLATFORM, xdgDataHome: '/xdg/data' })
    await expect(probeRootPath(createOpenCodeProvider('/explicit/base', paths))).resolves.toBe(
      join('/explicit/base', 'opencode'),
    )
  })

  it('the module singleton still resolves with no argument at all', async () => {
    // Registry wiring requirement: `export const opencode = createOpenCodeProvider()`
    // must keep working untouched, since the trailing `paths` defaults to the
    // ambient snapshot.
    expect(opencode.name).toBe('opencode')
    await expect(probeRootPath(opencode)).resolves.toBe(ambientOpenCodeDataDir())
  })
})

// ── OPENCODE_DB_PREFIX ──
// `dbFilePrefix` is not visible through `probeRoots`, so these cases plant two
// real SQLite DBs and read the prefix back out of what discovery selects. That
// is the only way to observe the `|| 'opencode'` default: with `??`, an empty
// prefix would match every `*.db` and sweep the fork's DB into the ledger
// (issue #617), which is exactly what the empty-parity case below pins.
const SESSION_BY_DB: Readonly<Record<string, string>> = {
  'opencode.db': 'ses-opencode',
  'mimocode.db': 'ses-mimocode',
}
const tempDirs: string[] = []

function makeFixtureDb(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_archived INTEGER, parent_id TEXT)',
    )
    db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created INTEGER, data BLOB)')
    db.exec('CREATE TABLE part (message_id TEXT, data BLOB)')
    db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
      sessionId,
      '/tmp/project',
      'fixture',
      1,
    )
  } finally {
    db.close()
  }
}

/** A data dir holding one DB per known fork name, each with one session row.
 *  `createOpenCodeProvider(base)` appends the 'opencode' subdirectory to its
 *  explicit base (the fixture-preserving test seam), so the DBs live there. */
function makeFixtureDataDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'tr-opencode-paths-'))
  tempDirs.push(base)
  const dataDir = join(base, 'opencode')
  mkdirSync(dataDir, { recursive: true })
  for (const [file, sessionId] of Object.entries(SESSION_BY_DB)) makeFixtureDb(join(dataDir, file), sessionId)
  return base
}

/** Session ids out of `<dbPath>:<sessionId>` — split from the right, because a
 *  Windows `dbPath` carries a drive colon. */
async function discoveredSessions(provider: Provider): Promise<string[]> {
  const sources = await provider.discoverSessions()
  return sources.map(source => source.path.slice(source.path.lastIndexOf(':') + 1)).sort()
}

/** The ids a given prefix selects, derived from the fixture names only. */
function expectedForPrefix(prefix: string): string[] {
  return Object.entries(SESSION_BY_DB)
    .filter(([file]) => file.startsWith(prefix) && file.endsWith('.db'))
    .map(([, sessionId]) => sessionId)
    .sort()
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('createOpenCodeProvider (OPENCODE_DB_PREFIX seam, || default)', () => {
  it('the default prefix selects only the opencode DB', async () => {
    const dir = makeFixtureDataDir()
    const provider = createOpenCodeProvider(dir, pathsWith({}, NO_PLATFORM))
    await expect(discoveredSessions(provider)).resolves.toEqual(['ses-opencode'])
  })

  it('a threaded prefix selects the fork DB instead', async () => {
    const dir = makeFixtureDataDir()
    const provider = createOpenCodeProvider(dir, pathsWith({ OPENCODE_DB_PREFIX: 'mimocode' }, NO_PLATFORM))
    await expect(discoveredSessions(provider)).resolves.toEqual(['ses-mimocode'])
  })

  it('a defined-empty prefix falls back to opencode instead of sweeping every *.db', async () => {
    // The `||` (not `??`) the reader depends on: `''` must NOT become the
    // prefix, or `startsWith('')` would match both DBs.
    const dir = makeFixtureDataDir()
    const provider = createOpenCodeProvider(dir, pathsWith({ OPENCODE_DB_PREFIX: '' }, NO_PLATFORM))
    await expect(discoveredSessions(provider)).resolves.toEqual(['ses-opencode'])
  })

  it('unthreaded selects exactly what the ambient OPENCODE_DB_PREFIX selected', async () => {
    const dir = makeFixtureDataDir()
    await expect(discoveredSessions(createOpenCodeProvider(dir))).resolves.toEqual(
      expectedForPrefix(process.env['OPENCODE_DB_PREFIX'] || 'opencode'),
    )
  })

  it('the explicit dataDir seam still wins over a threaded prefix', async () => {
    const dir = makeFixtureDataDir()
    const provider = createOpenCodeProvider(dir, pathsWith({ OPENCODE_DB_PREFIX: 'mimocode' }, NO_PLATFORM))
    await expect(discoveredSessions(provider)).resolves.toEqual(expectedForPrefix('mimocode'))
  })
})

describe('getRegistryPath (CRUSH_GLOBAL_DATA / LOCALAPPDATA / XDG_DATA_HOME seams)', () => {
  it('threaded override wins over both platform roots', () => {
    const paths = pathsWith(
      { CRUSH_GLOBAL_DATA: '/crush/global' },
      { ...NO_PLATFORM, localAppData: '/local', xdgDataHome: '/xdg/data' },
    )
    expect(getRegistryPath(paths)).toBe(join('/crush/global', 'projects.json'))
  })

  it('a defined-empty override is falsy and falls through to the platform branch', () => {
    const paths = pathsWith(
      { CRUSH_GLOBAL_DATA: '' },
      { ...NO_PLATFORM, localAppData: '/local', xdgDataHome: '/xdg/data' },
    )
    expect(getRegistryPath(paths)).toBe(platformBranch('/local', '/xdg/data'))
  })

  it.skipIf(!isWindows)('a threaded LOCALAPPDATA root is honored on win32', () => {
    const paths = pathsWith({}, { ...NO_PLATFORM, localAppData: '/local' })
    expect(getRegistryPath(paths)).toBe(join('/local', 'crush', 'projects.json'))
  })

  it.skipIf(isWindows)('a threaded XDG_DATA_HOME root is honored off win32', () => {
    const paths = pathsWith({}, { ...NO_PLATFORM, xdgDataHome: '/xdg/data' })
    expect(getRegistryPath(paths)).toBe(join('/xdg/data', 'crush', 'projects.json'))
  })

  it('null platform roots fall back to the homedir defaults (null parity with unset)', () => {
    expect(getRegistryPath(pathsWith({}, NO_PLATFORM))).toBe(platformBranch(null, null))
  })

  it('a defined-empty platform root still joins as a relative path (?? parity, never nulled)', () => {
    const emptyBoth = getRegistryPath(pathsWith({}, { ...NO_PLATFORM, localAppData: '', xdgDataHome: '' }))
    expect(emptyBoth).toBe(join('', 'crush', 'projects.json'))
  })

  it('unthreaded resolves exactly what the three process.env reads resolved', () => {
    const explicit = process.env['CRUSH_GLOBAL_DATA']
    const expected = explicit
      ? join(explicit, 'projects.json')
      : platformBranch(process.env['LOCALAPPDATA'] ?? null, process.env['XDG_DATA_HOME'] ?? null)
    expect(getRegistryPath()).toBe(expected)
  })

  it('the module singleton and factory still construct with no argument', () => {
    expect(crush.name).toBe('crush')
    expect(createCrushProvider().name).toBe('crush')
    expect(createCrushProvider(pathsWith({ CRUSH_GLOBAL_DATA: '/crush/global' }, NO_PLATFORM)).name).toBe('crush')
  })

  it('discovery on a missing registry resolves [] instead of throwing', async () => {
    const provider = createCrushProvider(pathsWith({ CRUSH_GLOBAL_DATA: '/definitely/missing/tr-crush' }, NO_PLATFORM))
    await expect(provider.discoverSessions()).resolves.toEqual([])
  })
})
