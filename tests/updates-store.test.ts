import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canRequestUpdate,
  selectUpdateStatus,
  useUpdatesStore,
} from '../src/renderer/src/features/settings/updates-store.js'
import type { UpdateStatus } from '../src/shared/schemas/updates.js'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function api(overrides: Record<string, unknown> = {}) {
  const calls = {
    getUpdateStatus: vi.fn(async () => status()),
    checkForUpdates: vi.fn(async () => status('available', 2)),
    downloadUpdate: vi.fn(async () => status('ready', 4)),
    installUpdate: vi.fn(async () => status('installing', 5)),
  }
  vi.stubGlobal('window', { api: { ...calls, ...overrides } })
  return calls
}

function snapshot(): UpdateStatus | null {
  return selectUpdateStatus(useUpdatesStore.getState().machine)
}

beforeEach(() => useUpdatesStore.setState(useUpdatesStore.getInitialState(), true))
afterEach(() => vi.unstubAllGlobals())

describe('Zustand update lifecycle', () => {
  it('starts uninitialized, hydrates once, and never checks or downloads at startup', async () => {
    expect(useUpdatesStore.getState().machine).toEqual({ state: 'uninitialized' })
    const calls = api()
    await Promise.all([useUpdatesStore.getState().load(), useUpdatesStore.getState().load()])
    await useUpdatesStore.getState().load()
    expect(calls.getUpdateStatus).toHaveBeenCalledTimes(1)
    expect(calls.checkForUpdates).not.toHaveBeenCalled()
    expect(calls.downloadUpdate).not.toHaveBeenCalled()
    expect(snapshot()).toEqual(status())
  })

  it('has a retryable load failure for rejected or malformed IPC', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline IPC'))
      .mockResolvedValueOnce({ phase: 'idle' })
      .mockResolvedValue(status())
    api({ getUpdateStatus: load })
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState().machine.state).toBe('load-error')
    await useUpdatesStore.getState().check()
    expect(useUpdatesStore.getState().machine.state).toBe('load-error')
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState().machine.state).toBe('load-error')
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState().machine.state).toBe('synced')
  })

  it.each(['success', 'failure'])('an event supersedes a delayed hydration %s', async outcome => {
    const load = deferred<unknown>()
    api({ getUpdateStatus: () => load.promise })
    const pending = useUpdatesStore.getState().load()
    useUpdatesStore.getState().onStatus(status('ready', 8))
    load.resolve(outcome === 'success' ? status('idle', 0) : {})
    await pending
    expect(snapshot()).toEqual(status('ready', 8))
    expect(useUpdatesStore.getState().machine.state).toBe('synced')
  })

  it('guards duplicate and invalid commands before IPC and never chains user actions', async () => {
    const check = deferred<UpdateStatus>()
    const calls = api({ checkForUpdates: vi.fn(() => check.promise) })
    await useUpdatesStore.getState().check()
    await useUpdatesStore.getState().download()
    await useUpdatesStore.getState().install()
    await useUpdatesStore.getState().load()
    await useUpdatesStore.getState().download()
    await useUpdatesStore.getState().install()
    const pending = useUpdatesStore.getState().check()
    expect(useUpdatesStore.getState().machine).toMatchObject({ state: 'requesting', command: 'check' })
    await useUpdatesStore.getState().check()
    await useUpdatesStore.getState().download()
    useUpdatesStore.getState().onStatus(status('available', 2))
    await useUpdatesStore.getState().download()
    expect(calls.downloadUpdate).not.toHaveBeenCalled()
    check.resolve(status('available', 2))
    await pending
    expect(calls.installUpdate).not.toHaveBeenCalled()
    await useUpdatesStore.getState().download()
    expect(calls.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(calls.installUpdate).not.toHaveBeenCalled()
    await useUpdatesStore.getState().check()
    await useUpdatesStore.getState().download()
    expect(calls.downloadUpdate).toHaveBeenCalledTimes(1)
    await useUpdatesStore.getState().install()
    await useUpdatesStore.getState().install()
    expect(calls.installUpdate).toHaveBeenCalledTimes(1)
    expect(snapshot()?.phase).toBe('installing')
  })

  it('retains newer progress and completion events when an older command reply arrives', async () => {
    const download = deferred<UpdateStatus>()
    api({ downloadUpdate: () => download.promise })
    useUpdatesStore.getState().onStatus(status('available', 2))
    const pending = useUpdatesStore.getState().download()
    useUpdatesStore.getState().onStatus(status('downloading', 3))
    useUpdatesStore.getState().onStatus({ ...status('downloading', 4), progress: 75 })
    useUpdatesStore.getState().onStatus(status('ready', 5))
    useUpdatesStore.getState().onStatus(status('downloading', 3))
    download.resolve(status('downloading', 4))
    await pending
    expect(snapshot()).toEqual(status('ready', 5))
    expect(canRequestUpdate(useUpdatesStore.getState().machine, 'install')).toBe(true)
  })

  it('accepts a newer command result even after a progress event', async () => {
    const download = deferred<UpdateStatus>()
    api({ downloadUpdate: () => download.promise })
    useUpdatesStore.getState().onStatus(status('available', 2))
    const pending = useUpdatesStore.getState().download()
    useUpdatesStore.getState().onStatus(status('downloading', 3))
    download.resolve(status('ready', 4))
    await pending
    expect(snapshot()?.phase).toBe('ready')
  })

  it('surfaces command failure, keeps the authoritative snapshot, and allows retry', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('IPC failed')).mockResolvedValue(status('ready', 4))
    api({ downloadUpdate: download })
    useUpdatesStore.getState().onStatus(status('available', 2))
    await useUpdatesStore.getState().download()
    expect(useUpdatesStore.getState().machine).toMatchObject({ state: 'request-error', status: status('available', 2) })
    expect(canRequestUpdate(useUpdatesStore.getState().machine, 'install')).toBe(false)
    await useUpdatesStore.getState().download()
    expect(snapshot()?.phase).toBe('ready')
  })

  it('does not let an old event clear a request error or regress an authoritative snapshot', async () => {
    api({ checkForUpdates: async () => ({ invalid: true }) })
    useUpdatesStore.getState().onStatus(status('idle', 2))
    await useUpdatesStore.getState().check()
    const failed = useUpdatesStore.getState().machine
    useUpdatesStore.getState().onStatus(status('idle', 2))
    expect(useUpdatesStore.getState().machine).toBe(failed)
    useUpdatesStore.getState().onStatus(status('available', 3))
    expect(useUpdatesStore.getState().machine.state).toBe('synced')
  })

  it('ignores a response from a previous store lifetime', async () => {
    const old = deferred<UpdateStatus>()
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(status('ready', 10))
    api({ getUpdateStatus: load })
    const pending = useUpdatesStore.getState().load()
    useUpdatesStore.setState(useUpdatesStore.getInitialState(), true)
    await useUpdatesStore.getState().load()
    old.resolve(status())
    await pending
    expect(snapshot()?.phase).toBe('ready')
  })

  it.each(['checking', 'downloading', 'installing', 'unsupported'] as const)(
    'refuses every user command during %s',
    async phase => {
      const calls = api()
      useUpdatesStore.getState().onStatus(status(phase, 4))
      await useUpdatesStore.getState().check()
      await useUpdatesStore.getState().download()
      await useUpdatesStore.getState().install()
      expect(calls.checkForUpdates).not.toHaveBeenCalled()
      expect(calls.downloadUpdate).not.toHaveBeenCalled()
      expect(calls.installUpdate).not.toHaveBeenCalled()
    },
  )
})
