import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcDataWorker } from '../src/platform/electron/main/rpc/handlers.js'
import type { NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import { appliedLedgerGenerationAtom } from '../src/renderer/stores/atoms/config-change.js'
import {
  type AppLifecycleReadiness,
  applyLifecycleFrame,
  type LifecycleCursor,
} from '../src/renderer/stores/atoms/rpc-lifecycle.js'
import {
  createSettingsCapabilityAtoms,
  MCP_STATUS_REQUEST,
  PROVIDERS_REQUEST,
  SETTINGS_INFO_REQUEST,
} from '../src/renderer/features/settings/capability-atoms.js'
import { mountSettingsCapabilityWorkflow } from '../src/renderer/features/settings/capability-atoms.js'
import type { AppLifecycleFrame } from '../src/shared/rpc/lifecycle.js'
import { makeSettingsRpcTestClient } from './settings-rpc-test-helper.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
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

interface SettingsOverrides {
  readonly request?: RpcDataWorker['request']
  readonly native?: Partial<NativeRpcCapabilities>
  readonly openSettings?: () => Effect.Effect<boolean>
  readonly ledgerGeneration?: number
}

function setup(overrides: SettingsOverrides = {}) {
  const factory = Atom.context()
  const registry = AtomRegistry.make()
  registries.push(registry)
  const events: string[] = []
  const request =
    overrides.request ??
    (async (operation: string): Promise<unknown> => {
      switch (operation) {
        case 'settings:info':
        case 'settings:clear':
          return settings
        case 'store:analytics':
          return analytics
        case 'pricing:refresh':
          return { ok: true }
        default:
          throw new Error(`Unexpected worker request: ${operation}`)
      }
    })
  const client = makeSettingsRpcTestClient(
    factory,
    request,
    overrides.native,
    Effect.succeed(overrides.ledgerGeneration ?? 0),
    { openSettings: overrides.openSettings },
  )
  const atoms = createSettingsCapabilityAtoms(client, {
    rescan: () => events.push('rescan'),
  })
  return { atoms, client, factory, registry, events }
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
    const request = vi.fn(async (operation: string) => {
      if (operation === 'settings:info') return settings
      if (operation === 'store:analytics') return analytics
      throw new Error(`Unexpected worker request: ${operation}`)
    })
    const { atoms, registry } = setup({ request })
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
      expect(request).toHaveBeenCalledTimes(2)
      expect(request).toHaveBeenCalledWith('settings:info')
      expect(request).toHaveBeenCalledWith('store:analytics')
    } finally {
      releaseSettings()
      releaseProviders()
    }
  })

  it('starts a rescan only after the reset event has been applied', async () => {
    const events: string[] = []
    const factory = Atom.context()
    const registry = AtomRegistry.make()
    registries.push(registry)
    let ledgerGeneration = 0
    const cursor: LifecycleCursor = { epoch: 'clear-test', generation: 0, sequence: 0 }
    const applyReset = async (generation: number) => {
      ledgerGeneration = generation
      const frame: AppLifecycleFrame = {
        _tag: 'Event',
        envelope: {
          epoch: 'clear-test',
          sequence: generation,
          ledgerGeneration: generation,
          configRevision: 0,
          event: { _tag: 'LedgerReset', ledgerGeneration: generation },
        },
      }
      await Effect.runPromise(
        Effect.provide(
          applyLifecycleFrame(
            cursor,
            {
              registry,
              readinessAtom: Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null })),
              invalidate: () => Effect.sync(() => events.push('invalidate')),
              resetLedger: () => events.push('reset'),
              onEvent: () => Effect.void,
            },
            frame,
          ),
          Reactivity.layer,
        ),
      )
    }
    const request = vi.fn(async (operation: string): Promise<unknown> => {
      if (operation === 'settings:clear') {
        events.push('clear')
        await applyReset(1)
        return settings
      }
      if (operation === 'store:analytics') return analytics
      throw new Error(`Unexpected worker request: ${operation}`)
    })
    const client = makeSettingsRpcTestClient(
      factory,
      request,
      {},
      Effect.sync(() => ledgerGeneration),
    )
    const atoms = createSettingsCapabilityAtoms(client, {
      rescan: () => events.push('rescan'),
    })
    registry.set(atoms.providersQuery.requestAtom, PROVIDERS_REQUEST)
    const unpin = atoms.providersQuery.pin(registry)
    await waitForSuccess(registry, atoms.providersQuery.resultAtom)
    const result = await dispatch(registry, atoms.clearDataAtom, undefined)
    expect(result).toEqual({ ok: true, settings })
    expect(events).toEqual(['clear', 'reset', 'invalidate', 'rescan'])
    expect(registry.get(atoms.settingsInfoQuery.requestAtom)).toBeNull()
    expect(registry.get(atoms.providersQuery.requestAtom)).toEqual(PROVIDERS_REQUEST)
    expect(request.mock.calls.filter(([operation]) => operation === 'store:analytics')).toHaveLength(1)
    unpin()
  })

  it('waits for the applied reset generation when the clear acknowledgement arrives first', async () => {
    const events: string[] = []
    const cursor: LifecycleCursor = { epoch: 'clear-test', generation: 0, sequence: 0 }
    const {
      atoms,
      events: workflowEvents,
      registry,
    } = setup({
      ledgerGeneration: 4,
      request: async operation => {
        if (operation === 'settings:clear') return settings
        throw new Error(`Unexpected worker request: ${operation}`)
      },
    })
    const applyReset = (generation: number) => {
      const frame: AppLifecycleFrame = {
        _tag: 'Event',
        envelope: {
          epoch: 'clear-test',
          sequence: generation,
          ledgerGeneration: generation,
          configRevision: 0,
          event: { _tag: 'LedgerReset', ledgerGeneration: generation },
        },
      }
      return Effect.runPromise(
        Effect.provide(
          applyLifecycleFrame(
            cursor,
            {
              registry,
              readinessAtom: Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null })),
              invalidate: () => Effect.sync(() => events.push('invalidate')),
              resetLedger: () => events.push('reset'),
              onEvent: () => Effect.void,
            },
            frame,
          ),
          Reactivity.layer,
        ),
      )
    }
    const clearing = dispatch(registry, atoms.clearDataAtom, undefined)
    await vi.waitFor(() => expect(registry.get(atoms.clearDataAtom)).toMatchObject({ waiting: true }))
    expect(events).toEqual([])

    registry.set(appliedLedgerGenerationAtom, 3)
    await Promise.resolve()
    expect(events).toEqual([])
    expect(registry.get(appliedLedgerGenerationAtom)).toBe(3)
    expect(registry.get(atoms.clearDataAtom)).toMatchObject({ waiting: true })
    await applyReset(4)
    await expect(clearing).resolves.toEqual({ ok: true, settings })
    expect(events).toEqual(['reset', 'invalidate'])
    expect(workflowEvents).toEqual(['rescan'])
  })

  it('does not reset queries or rescan when clearing fails', async () => {
    const { atoms, events, registry } = setup({
      request: async (operation: string) => {
        if (operation === 'settings:clear') throw new Error('offline')
        throw new Error(`Unexpected worker request: ${operation}`)
      },
    })
    const result = await dispatch(registry, atoms.clearDataAtom, undefined)
    expect(result).toEqual({ ok: false, message: 'Configuration command failed' })
    expect(events).toEqual([])
    expect(registry.get(atoms.settingsInfoQuery.requestAtom)).toBeNull()
  })

  it('finishes an admitted clear after its pane subscriber unmounts', async () => {
    const factory = Atom.context()
    const registry = AtomRegistry.make()
    registries.push(registry)
    const events: string[] = []
    let finishClear: (() => void) | undefined
    const client = makeSettingsRpcTestClient(
      factory,
      () => new Promise(resolve => (finishClear = () => resolve(settings))),
    )
    const atoms = createSettingsCapabilityAtoms(client, {
      rescan: () => events.push('rescan'),
    })
    const releaseWindow = mountSettingsCapabilityWorkflow(registry, atoms)
    const releasePane = registry.subscribe(atoms.clearDataAtom, () => undefined)
    registry.set(atoms.clearDataAtom, undefined)
    await vi.waitFor(() => expect(finishClear).toBeDefined())
    releasePane()
    finishClear?.()
    await vi.waitFor(() => expect(registry.get(atoms.clearDataAtom)).toMatchObject({ _tag: 'Success' }))
    expect(events).toEqual(['rescan'])
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
    const { atoms, registry } = setup({
      native: { getLedgerMcpStatus, setLedgerMcpStartupMode, regenerateLedgerMcpToken },
    })
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
    const { atoms, registry } = setup({ native: { getLedgerMcpConnection } })
    expect(await dispatch(registry, atoms.getMcpConnectionAtom, undefined)).toEqual({ ok: true, connection })
    expect(getLedgerMcpConnection).toHaveBeenCalledTimes(1)
    expect('connection' in atoms).toBe(false)
  })

  it('opens System Settings through the generated RPC client', async () => {
    const openSystemSettings = vi.fn(() => Effect.succeed(true))
    const { atoms, registry } = setup({ openSettings: openSystemSettings })
    await expect(dispatch(registry, atoms.openSystemSettingsAtom, undefined)).resolves.toBe(true)
    expect(openSystemSettings).toHaveBeenCalledTimes(1)
  })

  it('invalidates active pricing queries once after a successful refresh and not after a failed refresh', async () => {
    let refreshes = 0
    let modelReads = 0
    const { atoms, client, registry } = setup({
      request: async (operation: string) => {
        if (operation === 'pricing:refresh') {
          refreshes += 1
          return refreshes === 1 ? { ok: true } : { ok: false, error: 'offline' }
        }
        if (operation === 'models:view') {
          modelReads += 1
          return null
        }
        throw new Error(`Unexpected worker request: ${operation}`)
      },
    })
    const modelsQuery = client.query(
      'models:view',
      { scope: { period: 'week' } },
      { serializationKey: 'settings-pricing', reactivityKeys: ['pricing'] },
    )
    registry.mount(modelsQuery)

    await waitForSuccess(registry, modelsQuery)
    expect(modelReads).toBe(1)
    expect(await dispatch(registry, atoms.refreshPricingAtom, undefined)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(modelReads).toBe(2))

    expect(await dispatch(registry, atoms.refreshPricingAtom, undefined)).toEqual({ ok: false, message: 'offline' })
    expect(modelReads).toBe(2)
  })
})
