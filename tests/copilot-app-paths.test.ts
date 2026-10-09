import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type AppPaths, appPaths, type PlatformPaths, type ProviderOverrides } from '../src/main/env.js'
import {
  copilot,
  createCopilotProvider,
  getAgentTracesDbPath,
  getCopilotSessionStateDir,
  getJetBrainsCopilotRoot,
} from '../src/main/pipeline/providers/copilot.js'

// `copilot.ts` seam composition, not the resolver: `overrideFor` /
// `platformFor` / `resolveProviderOverrides` and the override key list are
// already pinned in `tests/env.test.ts`. What is new here is that each reader
// keeps its OWN normalization on top of the snapshot — the `??` chains, the
// `=== '1'` flag, the `isAbsolute` XDG rejection, the `''`-is-a-value rule.
//
// Zero `process.env` mutation: every case builds `{ ...appPaths(), overrides,
// platform }` and passes it as the trailing argument. The two UNTHREADED cases
// read `process.env` in the ASSERTION (never write it), which is the parity
// that matters: with nothing threaded, `appPaths()` resolves through the same
// pure resolvers over the ambient env, so the seam still sees the old value.

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

describe('getCopilotSessionStateDir (WATCHTOWER_COPILOT_SESSION_STATE_DIR seam)', () => {
  it('the override argument wins over the snapshot', () => {
    expect(
      getCopilotSessionStateDir('/arg/session-state', pathsOf({ WATCHTOWER_COPILOT_SESSION_STATE_DIR: '/snap/state' })),
    ).toBe('/arg/session-state')
  })

  it('honors the snapshot value when no override is given', () => {
    expect(getCopilotSessionStateDir(undefined, pathsOf({ WATCHTOWER_COPILOT_SESSION_STATE_DIR: '/snap/state' }))).toBe(
      '/snap/state',
    )
  })

  it('unthreaded equals the old process.env read', () => {
    expect(getCopilotSessionStateDir()).toBe(
      process.env['WATCHTOWER_COPILOT_SESSION_STATE_DIR'] ?? join(homedir(), '.copilot', 'session-state'),
    )
    // The override argument still wins with no snapshot threaded.
    expect(getCopilotSessionStateDir('/arg/state')).toBe('/arg/state')
  })

  it('null/unset falls back to the homedir default; "" stays a value (?? parity, no || skip)', () => {
    expect(getCopilotSessionStateDir(undefined, pathsOf())).toBe(join(homedir(), '.copilot', 'session-state'))
    // The reader uses `??`, so an empty snapshot value is used verbatim — it is
    // NOT the `!== ''` normalization the claude readers apply.
    expect(getCopilotSessionStateDir(undefined, pathsOf({ WATCHTOWER_COPILOT_SESSION_STATE_DIR: '' }))).toBe('')
  })
})

describe('getAgentTracesDbPath (WATCHTOWER_COPILOT_OTEL_DB + APPDATA seams)', () => {
  it('honors the snapshot override when the file exists (the seam’s own existsSync gate)', () => {
    const dir = makeTempDir('tr-copilot-otel-')
    const db = join(dir, 'agent-traces.db')
    writeFileSync(db, '')
    expect(getAgentTracesDbPath(pathsOf({ WATCHTOWER_COPILOT_OTEL_DB: db }))).toBe(db)
  })

  it('a snapshot override pointing at a missing file returns null, as before', () => {
    const dir = makeTempDir('tr-copilot-otel-missing-')
    expect(getAgentTracesDbPath(pathsOf({ WATCHTOWER_COPILOT_OTEL_DB: join(dir, 'nope.db') }))).toBeNull()
  })

  it('an empty override is falsy exactly like an absent one — it falls through to the search', () => {
    const plat = NO_PLATFORM
    expect(getAgentTracesDbPath(pathsOf({ WATCHTOWER_COPILOT_OTEL_DB: '' }, plat))).toEqual(
      getAgentTracesDbPath(pathsOf({}, plat)),
    )
  })

  it('unthreaded equals the same read with the ambient snapshot threaded', () => {
    // `appPaths()` with no initialized record resolves `overrides` from
    // `process.env`, so this is the pre-migration `process.env[...]` read.
    expect(getAgentTracesDbPath()).toBe(getAgentTracesDbPath(appPaths()))
    if (process.env['WATCHTOWER_COPILOT_OTEL_DB'] === undefined) {
      const found = getAgentTracesDbPath()
      expect(found === null || found.endsWith('agent-traces.db')).toBe(true)
    }
  })

  // Windows-only branch: `platformFor(paths).appData` feeds the candidate
  // search there and nowhere else. CI is ubuntu (test.yml), so this pins the
  // Windows branch on the Windows dev box only.
  it.skipIf(osPlatform() !== 'win32')(
    'APPDATA: the snapshot root is the root, and "" never becomes the homedir default',
    () => {
      // A real candidate under a temp APPDATA root, so the search RESULT is
      // observable without depending on what VS Code is installed on this box.
      const dir = makeTempDir('tr-copilot-appdata-')
      const candidate = join(dir, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db')
      mkdirSync(dirname(candidate), { recursive: true })
      writeFileSync(candidate, '')

      expect(getAgentTracesDbPath(pathsOf({}, { ...NO_PLATFORM, appData: dir }))).toBe(candidate)

      // `null` ("unset") → the homedir default, the same `??` result `undefined`
      // produced: the candidate above is NOT reachable from there.
      const unset = getAgentTracesDbPath(pathsOf({}, NO_PLATFORM))
      expect(unset === null || unset.startsWith(join(homedir(), 'AppData', 'Roaming'))).toBe(true)
      expect(unset).not.toBe(candidate)

      // `''` is a real value for a `??` reader: the candidates are built from it
      // RELATIVE, and the homedir default is never substituted for it.
      expect(getAgentTracesDbPath(pathsOf({}, { ...NO_PLATFORM, appData: '' }))).not.toBe(candidate)
    },
  )
})

describe('getJetBrainsCopilotRoot (WATCHTOWER_COPILOT_JETBRAINS_DIR + XDG_CONFIG_HOME + LOCALAPPDATA seams)', () => {
  it('the override argument wins over the snapshot', () => {
    expect(getJetBrainsCopilotRoot('/arg/jetbrains', pathsOf({ WATCHTOWER_COPILOT_JETBRAINS_DIR: '/snap/jb' }))).toBe(
      '/arg/jetbrains',
    )
  })

  it('honors the snapshot value when no override is given', () => {
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({ WATCHTOWER_COPILOT_JETBRAINS_DIR: '/snap/jb' }))).toBe(
      '/snap/jb',
    )
  })

  it('an empty snapshot override is falsy and falls through, exactly like an absent one', () => {
    const plat = NO_PLATFORM
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({ WATCHTOWER_COPILOT_JETBRAINS_DIR: '' }, plat))).toBe(
      getJetBrainsCopilotRoot(undefined, pathsOf({}, plat)),
    )
  })

  it('unthreaded equals the old process.env read', () => {
    const ambient = process.env['WATCHTOWER_COPILOT_JETBRAINS_DIR']
    if (ambient) expect(getJetBrainsCopilotRoot()).toBe(ambient)
    expect(getJetBrainsCopilotRoot()).toBe(getJetBrainsCopilotRoot(undefined, appPaths()))
  })

  it('an absolute XDG_CONFIG_HOME wins, and "" / relative values are still rejected', () => {
    const xdg = makeTempDir('tr-copilot-xdg-')
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({}, { ...NO_PLATFORM, xdgConfigHome: xdg }))).toBe(
      join(xdg, 'github-copilot'),
    )
    // Reader-side asymmetry the snapshot must NOT resolve: this reader rejects
    // empty and relative XDG values, unlike the plain `??` readers.
    const fallback = getJetBrainsCopilotRoot(undefined, pathsOf({}, NO_PLATFORM))
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({}, { ...NO_PLATFORM, xdgConfigHome: '' }))).toBe(fallback)
    expect(
      getJetBrainsCopilotRoot(undefined, pathsOf({}, { ...NO_PLATFORM, xdgConfigHome: join('relative', 'xdg') })),
    ).toBe(fallback)
  })

  it.skipIf(osPlatform() !== 'win32')('LOCALAPPDATA: the snapshot root is used, null falls back to homedir', () => {
    const local = makeTempDir('tr-copilot-localappdata-')
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({}, { ...NO_PLATFORM, localAppData: local }))).toBe(
      join(local, 'github-copilot'),
    )
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({}, NO_PLATFORM))).toBe(
      join(join(homedir(), 'AppData', 'Local'), 'github-copilot'),
    )
    // `??` reader: `''` joins relative rather than falling back.
    expect(getJetBrainsCopilotRoot(undefined, pathsOf({}, { ...NO_PLATFORM, localAppData: '' }))).toBe(
      join('', 'github-copilot'),
    )
  })
})

describe('createCopilotProvider (WS / GLOBAL storage + DISABLE_OTEL seams)', () => {
  /** A workspaceStorage / globalStorage pair with one empty `.jsonl` each — the
   *  shape discovery keys on. No real provider data: the sources are the paths. */
  function storageFixture(prefix: string): { ws: string; global: string; wsSource: string; globalSource: string } {
    const root = makeTempDir(prefix)
    const ws = join(root, 'ws')
    const global = join(root, 'global')
    mkdirSync(join(ws, 'hash', 'chatSessions'), { recursive: true })
    mkdirSync(join(global, 'emptyWindowChatSessions'), { recursive: true })
    const wsSource = join(ws, 'hash', 'chatSessions', 'session.jsonl')
    const globalSource = join(global, 'emptyWindowChatSessions', 'session.jsonl')
    writeFileSync(wsSource, '')
    writeFileSync(globalSource, '')
    return { ws, global, wsSource, globalSource }
  }

  function providerFor(paths: AppPaths, root: string) {
    // The two override ARGUMENTS stay empty dirs; the snapshot decides the ws /
    // global roots, which is the pair of seams under test.
    const jsonl = join(root, 'session-state')
    const jetbrains = join(root, 'jetbrains')
    mkdirSync(jsonl, { recursive: true })
    mkdirSync(jetbrains, { recursive: true })
    return createCopilotProvider(jsonl, undefined, undefined, jetbrains, paths)
  }

  it('the snapshot WS and GLOBAL storage dirs are the roots discovery walks', async () => {
    const root = makeTempDir('tr-copilot-provider-')
    const { ws, global, wsSource, globalSource } = storageFixture('tr-copilot-provider-')
    const paths = pathsOf({
      WATCHTOWER_COPILOT_WS_STORAGE_DIR: ws,
      WATCHTOWER_COPILOT_GLOBAL_STORAGE_DIR: global,
      WATCHTOWER_COPILOT_DISABLE_OTEL: '1',
    })
    const sources = await providerFor(paths, root).discoverSessions()
    expect(sources.map(source => source.path).sort()).toEqual([wsSource, globalSource].sort())
    expect(sources.every(source => 'sourceType' in source && source.sourceType === 'chatsession')).toBe(true)
  })

  it('DISABLE_OTEL is a `=== "1"` comparison on the snapshot value, not a presence check', async () => {
    const root = makeTempDir('tr-copilot-otel-flag-')
    // `discoverOtelSessions` only stats the file, so an empty file is enough to
    // make the OTel source win (and, with it, skip the VS Code sources).
    const db = join(root, 'agent-traces.db')
    writeFileSync(db, '')

    const enabled = await providerFor(pathsOf({ WATCHTOWER_COPILOT_OTEL_DB: db }), root).discoverSessions()
    expect(enabled.map(source => ('sourceType' in source ? source.sourceType : undefined))).toEqual(['otel'])
    expect(enabled[0]?.path).toBe(db)

    // `'0'` and `''` are truthy but not `'1'`: OTel stays enabled, as before.
    for (const value of ['0', '', 'true']) {
      const sources = await providerFor(
        pathsOf({ WATCHTOWER_COPILOT_OTEL_DB: db, WATCHTOWER_COPILOT_DISABLE_OTEL: value }),
        root,
      ).discoverSessions()
      expect(sources.map(source => ('sourceType' in source ? source.sourceType : undefined))).toEqual(['otel'])
    }

    const { ws, wsSource } = storageFixture('tr-copilot-otel-flag-off-')
    const disabled = await providerFor(
      pathsOf({
        WATCHTOWER_COPILOT_OTEL_DB: db,
        WATCHTOWER_COPILOT_DISABLE_OTEL: '1',
        WATCHTOWER_COPILOT_WS_STORAGE_DIR: ws,
      }),
      root,
    ).discoverSessions()
    expect(disabled.map(source => ('sourceType' in source ? source.sourceType : undefined))).toEqual(['chatsession'])
    expect(disabled.map(source => source.path)).toEqual([wsSource])
  })

  it('the override ARGUMENTS still beat the snapshot', async () => {
    const root = makeTempDir('tr-copilot-arg-wins-')
    const { ws, wsSource } = storageFixture('tr-copilot-arg-wins-fx-')
    const paths = pathsOf({
      WATCHTOWER_COPILOT_WS_STORAGE_DIR: ws,
      WATCHTOWER_COPILOT_DISABLE_OTEL: '1',
    })
    // The ws override ARGUMENT points at an empty dir while the snapshot points
    // at the fixture: the argument wins, so the fixture is never walked.
    const argWs = join(root, 'arg-ws')
    mkdirSync(argWs, { recursive: true })
    const sources = await createCopilotProvider(
      join(root, 'session-state'),
      argWs,
      join(root, 'arg-global'),
      join(root, 'jetbrains'),
      paths,
    ).discoverSessions()
    expect(sources).toEqual([])
    expect(sources.map(source => source.path)).not.toContain(wsSource)
  })

  it('the module-level singleton is still built with zero arguments', () => {
    // `export const copilot = createCopilotProvider()` at module scope: the
    // `(paths ?? appPaths())` default is what keeps that working.
    expect(copilot.name).toBe('copilot')
    expect(copilot.durableSources).toBe(true)
    expect(copilot.discoverSessions).toBeTypeOf('function')
  })
})
