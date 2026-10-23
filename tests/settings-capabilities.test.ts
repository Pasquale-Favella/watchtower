import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSettingsCapabilityAtoms,
  MCP_STATUS_REQUEST,
  PROVIDERS_REQUEST,
  SETTINGS_INFO_REQUEST,
} from '../src/renderer/src/features/settings/capability-atoms.js'
import { mountSettingsCapabilityWorkflow } from '../src/renderer/src/features/settings/capability-atoms.js'
import { legacyRendererApi, RendererApi, RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

const settings = {
  dataDir: '/data',
  dbSize: 10,
  dataDirSize: 20,
  cacheDir: '/cache',
  cacheSize: 5,
}
const status = { startupMode: 'on-demand' as const, running: false, url: null }
const analytics = {
  providers: [{ name: 'claude', cost: 1, calls: 2, sessions: 3 }],
  models: [],
  categories: [],
  skills: [],
  subagents: [],
}

type ApiOverrides = Partial<RendererApi['Service']>

function setup(overrides: ApiOverrides = {}) {
  const factory = Atom.context()
  const registry = AtomRegistry.make()
  registries.push(registry)
  const events: string[] = []
  const atoms = createSettingsCapabilityAtoms(
    factory,
    {
      resetLedgerQueries: () => events.push('reset'),
      rescan: () => events.push('rescan'),
    },
    Layer.succeed(RendererApi, { ...legacyRendererApi, ...overrides }),
  )
  return { atoms, factory, registry, events }
}

async function dispatch<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  input: Arg,
): Promise<A> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined
    unsubscribe = registry.subscribe(atom, result => {
      if (result.waiting || result._tag === 'Initial') return
      unsubscribe()
      if (result._tag === 'Success') resolve(result.value)
      else reject(result)
    })
    registry.set(atom, input)
  })
}

async function waitForSuccess<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>): Promise<A> {
  await vi.waitFor(() => expect(registry.get(atom)).toMatchObject({ _tag: 'Success', waiting: false }))
  return (registry.get(atom) as { value: A }).value
}

describe('settings capability atoms', () => {
  it('loads Settings info and detected providers through native queries', async () => {
    const getSettings = vi.fn(() => Effect.succeed(settings))
    const getAnalytics = vi.fn(() => Effect.succeed(analytics))
    const { atoms, registry } = setup({ getSettings, getAnalytics })
    registry.set(atoms.settingsInfoQuery.requestAtom, SETTINGS_INFO_REQUEST)
    registry.set(atoms.providersQuery.requestAtom, PROVIDERS_REQUEST)
    const releaseSettings = atoms.settingsInfoQuery.pin(registry)
    const releaseProviders = atoms.providersQuery.pin(registry)
    try {
      await Promise.all([
        waitForSuccess(registry, atoms.settingsInfoQuery.resultAtom),
        waitForSuccess(registry, atoms.providersQuery.resultAtom),
      ])
      expect(registry.get(atoms.settingsInfoQuery.resultAtom)).toMatchObject({ value: settings })
      expect(registry.get(atoms.providersQuery.resultAtom)).toMatchObject({ value: analytics })
      expect(getSettings).toHaveBeenCalledTimes(1)
      expect(getAnalytics).toHaveBeenCalledTimes(1)
    } finally {
      releaseSettings()
      releaseProviders()
    }
  })

  it('resets queries and starts a rescan only after a successful clear', async () => {
    const events: string[] = []
    const factory = Atom.context()
    const registry = AtomRegistry.make()
    registries.push(registry)
    const getAnalytics = vi.fn(() => Effect.succeed(analytics))
    const atoms = createSettingsCapabilityAtoms(
      factory,
      {
        resetLedgerQueries: () => {
          events.push('reset')
        },
        rescan: () => events.push('rescan'),
      },
      Layer.succeed(RendererApi, {
        ...legacyRendererApi,
        clearData: () =>
          Effect.sync(() => {
            events.push('clear')
            return settings
          }),
        getAnalytics,
      }),
    )
    registry.set(atoms.providersQuery.requestAtom, PROVIDERS_REQUEST)
    const unpin = atoms.providersQuery.pin(registry)
    await waitForSuccess(registry, atoms.providersQuery.resultAtom)
    const result = await dispatch(registry, atoms.clearDataAtom, undefined)
    expect(result).toEqual({ ok: true, settings })
    expect(events).toEqual(['clear', 'reset', 'rescan'])
    expect(registry.get(atoms.settingsInfoQuery.requestAtom)).toEqual(SETTINGS_INFO_REQUEST)
    expect(registry.get(atoms.providersQuery.requestAtom)).toEqual(PROVIDERS_REQUEST)
    expect(getAnalytics).toHaveBeenCalledTimes(2)
    unpin()
  })

  it('does not reset queries or rescan when clearing fails', async () => {
    const failure = new RendererApiError({ operation: 'settings:clear', message: 'offline' })
    const { atoms, events, registry } = setup({ clearData: () => Effect.fail(failure) })
    const result = await dispatch(registry, atoms.clearDataAtom, undefined)
    expect(result).toEqual({ ok: false, message: 'offline' })
    expect(events).toEqual([])
    expect(registry.get(atoms.settingsInfoQuery.requestAtom)).toBeNull()
  })

  it('finishes an admitted clear after its pane subscriber unmounts', async () => {
    const factory = Atom.context()
    const registry = AtomRegistry.make()
    registries.push(registry)
    const events: string[] = []
    let finishClear: (() => void) | undefined
    const atoms = createSettingsCapabilityAtoms(
      factory,
      {
        resetLedgerQueries: () => events.push('reset'),
        rescan: () => events.push('rescan'),
      },
      Layer.succeed(RendererApi, {
        ...legacyRendererApi,
        clearData: () => Effect.promise(() => new Promise(resolve => (finishClear = () => resolve(settings)))),
      }),
    )
    const releaseWindow = mountSettingsCapabilityWorkflow(registry, atoms)
    const releasePane = registry.subscribe(atoms.clearDataAtom, () => undefined)
    registry.set(atoms.clearDataAtom, undefined)
    await vi.waitFor(() => expect(finishClear).toBeDefined())
    releasePane()
    finishClear?.()
    await vi.waitFor(() => expect(registry.get(atoms.clearDataAtom)).toMatchObject({ _tag: 'Success' }))
    expect(events).toEqual(['reset', 'rescan'])
    releaseWindow()
  })

  it('updates MCP status after startup changes and token regeneration', async () => {
    const getLedgerMcpStatus = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(status))
      .mockReturnValueOnce(Effect.succeed({ ...status, startupMode: 'at-launch' as const }))
      .mockReturnValueOnce(Effect.succeed({ ...status, startupMode: 'at-launch' as const, running: true }))
    const setLedgerMcpStartupMode = vi.fn(() => Effect.succeed({ ...status, startupMode: 'at-launch' as const }))
    const regenerateLedgerMcpToken = vi.fn(() =>
      Effect.succeed({ ...status, startupMode: 'at-launch' as const, running: true }),
    )
    const { atoms, registry } = setup({ getLedgerMcpStatus, setLedgerMcpStartupMode, regenerateLedgerMcpToken })
    registry.set(atoms.mcpStatusQuery.requestAtom, MCP_STATUS_REQUEST)
    const unpin = atoms.mcpStatusQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.mcpStatusQuery.resultAtom)
      expect(await dispatch(registry, atoms.setMcpStartupModeAtom, 'at-launch')).toEqual({ ok: true })
      await vi.waitFor(() => expect(getLedgerMcpStatus).toHaveBeenCalledTimes(2))
      expect(await dispatch(registry, atoms.regenerateMcpTokenAtom, undefined)).toEqual({ ok: true })
      await vi.waitFor(() => expect(getLedgerMcpStatus).toHaveBeenCalledTimes(3))
      expect(setLedgerMcpStartupMode).toHaveBeenCalledWith('at-launch')
      expect(regenerateLedgerMcpToken).toHaveBeenCalledTimes(1)
    } finally {
      unpin()
    }
  })

  it('returns connection credentials only from the explicit connection command', async () => {
    const connection = { url: 'http://127.0.0.1:1234', config: '{"token":"secret"}' }
    const getLedgerMcpConnection = vi.fn(() => Effect.succeed(connection))
    const { atoms, registry } = setup({ getLedgerMcpConnection })
    expect(await dispatch(registry, atoms.getMcpConnectionAtom, undefined)).toEqual({ ok: true, connection })
    expect(getLedgerMcpConnection).toHaveBeenCalledTimes(1)
    expect('connection' in atoms).toBe(false)
  })
})
