import * as Effect from 'effect/Effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'

import type { NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import {
  createUpdatesAtoms,
  selectUpdateActivity,
  selectUpdateCommandVisible,
  selectUpdateStatus,
} from '../src/renderer/features/settings/updates-atoms.js'
import type { UpdateStatus } from '../src/shared/schemas/updates.js'
import { makeSettingsRpcTestClient } from './settings-rpc-test-helper.js'

function status(phase: UpdateStatus['phase'] = 'idle', revision = 0): UpdateStatus {
  const updateAvailable = ['available', 'downloading', 'ready', 'installing'].includes(phase)
  return {
    revision,
    phase,
    currentVersion: '0.2.6',
    latestVersion: updateAvailable ? '0.3.0' : null,
    updateAvailable,
    tag: updateAvailable ? 'v0.3.0' : null,
    installSupported: phase !== 'unsupported',
    progress: phase === 'downloading' ? 30 : null,
    message: null,
  }
}

type Overrides = Partial<
  Pick<NativeRpcCapabilities, 'getUpdateStatus' | 'checkForUpdates' | 'downloadUpdate' | 'installUpdate'>
>

function makeHarness(overrides: Overrides = {}) {
  const runtime = Atom.context()
  const client = makeSettingsRpcTestClient(
    runtime,
    async () => {
      throw new Error('Unexpected worker operation in an updater test')
    },
    overrides,
  )
  const atoms = createUpdatesAtoms(client)
  const registry = AtomRegistry.make()
  return { atoms, registry }
}

function dispatch<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Promise<AsyncResult.AsyncResult<A, E>> {
  return new Promise(resolve => {
    let unsubscribe: () => void = () => undefined
    unsubscribe = registry.subscribe(atom, result => {
      if (!result.waiting && !AsyncResult.isInitial(result)) {
        unsubscribe()
        resolve(result)
      }
    })
    registry.set(atom, arg)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('native updater atoms', () => {
  it('hydrates status once without checking or downloading', async () => {
    const load = deferred<UpdateStatus>()
    const getUpdateStatus = vi.fn(() => Effect.promise(() => load.promise))
    const { atoms, registry } = makeHarness({ getUpdateStatus })

    const pending = dispatch(registry, atoms.loadUpdateStatusAtom, undefined)
    await vi.waitFor(() => expect(getUpdateStatus).toHaveBeenCalledTimes(1))
    registry.set(atoms.loadUpdateStatusAtom, undefined)
    await Promise.resolve()
    load.resolve(status())
    await pending

    expect(getUpdateStatus).toHaveBeenCalledTimes(1)
    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'synced', status: status() })
  })

  it('uses a retryable state for failed load and succeeds on retry', async () => {
    const getUpdateStatus = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(new Error('offline')))
      .mockReturnValueOnce(Effect.succeed(status('current', 2)))
    const { atoms, registry } = makeHarness({ getUpdateStatus })

    await dispatch(registry, atoms.loadUpdateStatusAtom, undefined)
    expect(registry.get(atoms.machineAtom)).toMatchObject({ state: 'load-error' })
    await dispatch(registry, atoms.loadUpdateStatusAtom, undefined)
    expect(getUpdateStatus).toHaveBeenCalledTimes(2)
    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'synced', status: status('current', 2) })
  })

  it('lets a newer status event supersede a delayed hydration result', async () => {
    const load = deferred<UpdateStatus>()
    const { atoms, registry } = makeHarness({ getUpdateStatus: () => Effect.promise(() => load.promise) })
    const pending = dispatch(registry, atoms.loadUpdateStatusAtom, undefined)
    await vi.waitFor(() => expect(registry.get(atoms.machineAtom).state).toBe('loading'))

    registry.set(atoms.statusChangedAtom, status('ready', 8))
    load.resolve(status('idle', 0))
    await pending

    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'synced', status: status('ready', 8) })
  })

  it('admits only one updater command while allowing its Effect to finish', async () => {
    const check = deferred<UpdateStatus>()
    const checkForUpdates = vi.fn(() => Effect.promise(() => check.promise))
    const downloadUpdate = vi.fn(() => Effect.succeed(status('ready', 4)))
    const { atoms, registry } = makeHarness({ checkForUpdates, downloadUpdate })
    registry.set(atoms.statusChangedAtom, status('available', 2))

    const pending = dispatch(registry, atoms.checkForUpdatesAtom, undefined)
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1))
    registry.set(atoms.checkForUpdatesAtom, undefined)
    registry.set(atoms.downloadUpdateAtom, undefined)
    await Promise.resolve()
    registry.set(atoms.statusChangedAtom, status('available', 3))
    expect(registry.get(atoms.machineAtom)).toMatchObject({
      state: 'requesting',
      command: 'check',
      status: status('available', 3),
    })

    check.resolve(status('available', 2))
    await pending
    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'synced', status: status('available', 3) })
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('keeps newer progress and completion events when a command reply arrives late', async () => {
    const download = deferred<UpdateStatus>()
    const { atoms, registry } = makeHarness({ downloadUpdate: () => Effect.promise(() => download.promise) })
    registry.set(atoms.statusChangedAtom, status('available', 2))
    const pending = dispatch(registry, atoms.downloadUpdateAtom, undefined)
    await vi.waitFor(() => expect(registry.get(atoms.machineAtom).state).toBe('requesting'))
    registry.set(atoms.statusChangedAtom, status('downloading', 3))
    registry.set(atoms.statusChangedAtom, { ...status('downloading', 4), progress: 75 })
    registry.set(atoms.statusChangedAtom, status('ready', 5))
    registry.set(atoms.statusChangedAtom, status('downloading', 3))
    download.resolve(status('downloading', 4))
    await pending

    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'synced', status: status('ready', 5) })
    expect(selectUpdateCommandVisible(registry.get(atoms.machineAtom), 'install')).toBe(true)
  })

  it('maps typed command failures to retryable error state and retains the last snapshot', async () => {
    const downloadUpdate = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(new Error('offline')))
      .mockReturnValueOnce(Effect.succeed(status('ready', 4)))
    const { atoms, registry } = makeHarness({ downloadUpdate })
    registry.set(atoms.statusChangedAtom, status('available', 2))

    await dispatch(registry, atoms.downloadUpdateAtom, undefined)
    expect(registry.get(atoms.machineAtom)).toMatchObject({ state: 'request-error', status: status('available', 2) })
    await dispatch(registry, atoms.downloadUpdateAtom, undefined)
    expect(selectUpdateStatus(registry.get(atoms.machineAtom))).toEqual(status('ready', 4))
  })

  it.each(['checking', 'downloading', 'installing', 'unsupported'] as const)(
    'refuses every user command while updater phase is %s',
    async phase => {
      const checkForUpdates = vi.fn(() => Effect.succeed(status()))
      const downloadUpdate = vi.fn(() => Effect.succeed(status()))
      const installUpdate = vi.fn(() => Effect.succeed(status()))
      const { atoms, registry } = makeHarness({ checkForUpdates, downloadUpdate, installUpdate })
      registry.set(atoms.statusChangedAtom, status(phase, 4))

      await dispatch(registry, atoms.checkForUpdatesAtom, undefined)
      await dispatch(registry, atoms.downloadUpdateAtom, undefined)
      await dispatch(registry, atoms.installUpdateAtom, undefined)

      expect(checkForUpdates).not.toHaveBeenCalled()
      expect(downloadUpdate).not.toHaveBeenCalled()
      expect(installUpdate).not.toHaveBeenCalled()
    },
  )

  it('uses one phase policy for activity and command visibility', () => {
    const { atoms, registry } = makeHarness()
    registry.set(atoms.statusChangedAtom, status('idle', 0))
    expect(selectUpdateCommandVisible(registry.get(atoms.machineAtom), 'download')).toBe(false)
    registry.set(atoms.statusChangedAtom, status('downloading', 1))
    expect(selectUpdateActivity(registry.get(atoms.machineAtom))).toBe('download')
    registry.set(atoms.statusChangedAtom, { ...status('error', 3), updateAvailable: true })
    expect(selectUpdateCommandVisible(registry.get(atoms.machineAtom), 'download')).toBe(true)
    registry.dispose()
  })
})
