import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter as pathDelimiter, isAbsolute, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type AppPaths, appPaths, type PlatformPaths, type ProviderOverrides } from '../src/main/env.js'
import { claude, getClaudeConfigDirs, getDesktopSessionsDirs } from '../src/main/pipeline/providers/claude.js'

// `claude.ts` seam composition, not the resolver: `overrideFor` / `platformFor`
// / `resolveProviderOverrides` and the override key list are already pinned in
// `tests/env.test.ts`. What is new here is that each reader keeps its OWN
// normalization on top of the snapshot — the `!== ''` skips, the split/trim/
// resolve chain, and the `?.trim() || homedir-default` platform normalization
// that `null` ("unset") and `''` do NOT reach alike.
//
// Zero `process.env` mutation: every case builds `{ ...appPaths(), overrides,
// platform }` and passes it as the trailing argument. The UNTHREADED case reads
// `process.env` in the ASSERTION (never writes it): with nothing threaded,
// `appPaths()` resolves through the same pure resolvers over the ambient env,
// so the seam still sees the value it read before the migration.

const NO_PLATFORM: PlatformPaths = {
  appData: null,
  localAppData: null,
  xdgConfigHome: null,
  xdgDataHome: null,
}

/** A snapshot carrying only what the case passes; the rest mirrors production. */
function pathsOf(overrides: ProviderOverrides = {}, platform: PlatformPaths = appPaths().platform): AppPaths {
  return { ...appPaths(), overrides, platform }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('getClaudeConfigDirs (CLAUDE_CONFIG_DIRS + CLAUDE_CONFIG_DIR seams)', () => {
  it('honors the snapshot list: split on the platform delimiter, trim, resolve, dedupe', async () => {
    const first = makeTempDir('tr-claude-a-')
    const second = makeTempDir('tr-claude-b-')
    const value = [` ${first} `, '', second, first].join(pathDelimiter)
    // The blank entry is dropped by the reader's own `filter`, the repeat by
    // `dedupeResolved`, and the surrounding spaces by the per-entry `trim`.
    await expect(getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIRS: value }))).resolves.toEqual([
      resolve(first),
      resolve(second),
    ])
  })

  it('CLAUDE_CONFIG_DIRS still wins over CLAUDE_CONFIG_DIR (unchanged precedence)', async () => {
    const multi = makeTempDir('tr-claude-multi-')
    const single = makeTempDir('tr-claude-single-')
    await expect(
      getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIRS: multi, CLAUDE_CONFIG_DIR: single })),
    ).resolves.toEqual([resolve(multi)])
  })

  it('honors the snapshot single dir when the list var is absent', async () => {
    const single = makeTempDir('tr-claude-single-')
    await expect(getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIR: single }))).resolves.toEqual([resolve(single)])
  })

  it('an empty snapshot value is still skipped, exactly like an unset env var', async () => {
    // `overrideFor` reports `''` verbatim; the reader's own `!== ''` check is
    // what rejects it. Each side proves the OTHER var still decides.
    const multi = makeTempDir('tr-claude-multi-')
    await expect(getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIRS: '', CLAUDE_CONFIG_DIR: multi }))).resolves.toEqual([
      resolve(multi),
    ])

    const single = makeTempDir('tr-claude-single-')
    await expect(getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIRS: single, CLAUDE_CONFIG_DIR: '' }))).resolves.toEqual([
      resolve(single),
    ])

    // Both empty: neither env var decides, so the chain falls through to the
    // config-file / `~/.claude` layer — a different seam — and never returns an
    // empty or relative entry invented by an empty override.
    const fell = await getClaudeConfigDirs(pathsOf({ CLAUDE_CONFIG_DIRS: '', CLAUDE_CONFIG_DIR: '' }))
    expect(fell.length).toBeGreaterThan(0)
    expect(fell).not.toContain('')
    expect(fell.every(dir => dir !== '' && isAbsolute(dir))).toBe(true)
  })

  it('unthreaded equals the old process.env read', async () => {
    // Both calls resolve the ambient snapshot, which is `process.env` through
    // the same pure resolvers — so the unthreaded seam still sees the old value.
    await expect(getClaudeConfigDirs()).resolves.toEqual(await getClaudeConfigDirs(appPaths()))
  })
})

describe('getDesktopSessionsDirs (WATCHTOWER_DESKTOP_SESSIONS_DIR + APPDATA + LOCALAPPDATA seams)', () => {
  // The seam memoizes on `[platform, override, appData, localAppData]`, so every
  // case below uses a fresh temp dir (or a distinct value) to get its own key
  // and never reads another case's entry.
  it('honors the snapshot override and still resolves it like the override always did', () => {
    const dir = makeTempDir('tr-claude-desktop-')
    expect(getDesktopSessionsDirs(pathsOf({ WATCHTOWER_DESKTOP_SESSIONS_DIR: dir }))).toEqual([resolve(dir)])
  })

  it('an empty override is falsy and falls through, exactly like an absent one', () => {
    const local = makeTempDir('tr-claude-desktop-local-')
    const platform: PlatformPaths = { ...NO_PLATFORM, localAppData: local }
    expect(getDesktopSessionsDirs(pathsOf({ WATCHTOWER_DESKTOP_SESSIONS_DIR: '' }, platform))).toEqual(
      getDesktopSessionsDirs(pathsOf({}, platform)),
    )
  })

  it('a whitespace-only APPDATA is trimmed to the homedir default, never used verbatim', () => {
    // `'  '?.trim() || default` — the `||` is what collapses whitespace to the
    // homedir default; `null` collapses the same way. Both must land on the
    // same dirs, which is only observable if the two cache keys differ (they
    // do: `'  '` vs `null` in the JSON key).
    const local = makeTempDir('tr-claude-desktop-ws-')
    const whitespace = getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, appData: '  ', localAppData: local }))
    expect(whitespace).toEqual(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, localAppData: local })))
    // …and the whitespace never survives into a path: without the `.trim()` the
    // root would be the truthy `'  '` instead of the homedir default.
    expect(whitespace.every(dir => !dir.includes('  '))).toBe(true)
  })

  it('unthreaded equals the ambient read, and the override value is the env one', () => {
    const ambient = process.env['WATCHTOWER_DESKTOP_SESSIONS_DIR']
    if (ambient) expect(getDesktopSessionsDirs()).toEqual([resolve(ambient)])
    expect(getDesktopSessionsDirs()).toEqual(getDesktopSessionsDirs(appPaths()))
  })

  // Windows-only branches: `APPDATA` / `LOCALAPPDATA` are read there and
  // nowhere else. CI is ubuntu (test.yml), so these pin the Windows branch on
  // the Windows dev box only. `LOCALAPPDATA` points at an empty temp dir so
  // the MSIX `Packages` scan finds nothing and the candidate list is exact.
  it.skipIf(process.platform !== 'win32')(
    'APPDATA / LOCALAPPDATA are honored, null and "" fall back per the || chain',
    () => {
      const roaming = makeTempDir('tr-claude-roaming-')
      const local = makeTempDir('tr-claude-local-')
      expect(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, appData: roaming, localAppData: local }))).toEqual([
        join(roaming, 'Claude', 'local-agent-mode-sessions'),
      ])

      // `null` ("unset") → the homedir default on both roots.
      expect(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, localAppData: local }))).toEqual([
        join(join(homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions'),
      ])

      // `''` and `'  '` are real values that `.trim() || default` also collapses
      // to the homedir default — the `||`, not the snapshot, does that.
      for (const blank of ['', '  ']) {
        expect(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, appData: blank, localAppData: local }))).toEqual([
          join(join(homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions'),
        ])
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'the cache key keeps appData participating: two roots are two entries',
    () => {
      const first = makeTempDir('tr-claude-key-a-')
      const second = makeTempDir('tr-claude-key-b-')
      const local = makeTempDir('tr-claude-key-local-')
      expect(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, appData: first, localAppData: local }))).toEqual([
        join(first, 'Claude', 'local-agent-mode-sessions'),
      ])
      // If APPDATA were missing from the key, this would hit the first entry.
      expect(getDesktopSessionsDirs(pathsOf({}, { ...NO_PLATFORM, appData: second, localAppData: local }))).toEqual([
        join(second, 'Claude', 'local-agent-mode-sessions'),
      ])
    },
  )
})

describe('the module-level claude provider (zero-edit registry wiring)', () => {
  it('probeRoots resolves the same dirs the unthreaded seams return', async () => {
    // `claude` is built at module scope, and `Provider.probeRoots()` takes no
    // snapshot: the `(paths ?? appPaths())` default is what keeps the registry
    // entry working without edits.
    const dirs = await getClaudeConfigDirs()
    const [firstDir] = dirs
    expect(firstDir).toBeDefined()
    const roots = await claude.probeRoots?.()
    expect(roots?.[0]?.path).toBe(join(firstDir ?? homedir(), 'projects'))
    expect(roots?.slice(dirs.length).map(root => root.label)).toEqual(getDesktopSessionsDirs().map(() => 'desktop'))
  })
})
