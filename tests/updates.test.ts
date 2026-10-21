import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import { acquireElectronUpdates, configureElectronUpdater } from '../src/main/electron-updates.js'
import { createQuitCoordinator } from '../src/main/quit-coordinator.js'
import { releasePageUrl } from '../src/renderer/src/features/settings/updates.js'

const library = vi.hoisted(() => ({ updater: {} }))
vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      return library.updater
    },
  },
}))

describe('update platform policy', () => {
  it('enables an installed NSIS app and validates library check results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-update-policy-'))
    writeFileSync(join(directory, 'Uninstall Watchtower.exe'), '')
    const checkForUpdates = vi.fn().mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } })
    library.updater = Object.assign(new EventEmitter(), { checkForUpdates })
    try {
      const source = await Effect.runPromise(
        acquireElectronUpdates({
          isPackaged: true,
          platform: 'win32',
          appPath: directory,
          executablePath: join(directory, 'Watchtower.exe'),
          appImage: undefined,
          onInstallError: vi.fn(),
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      )
      expect(source.driver).not.toBeNull()
      if (!source.driver) throw new Error('Installed app should have an updater')
      expect(await Effect.runPromise(source.driver.check)).toEqual({ version: '0.3.0', available: true })
      checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.3.0-beta.1' } })
      expect(await Effect.runPromise(Effect.flip(source.driver.check))).toMatchObject({ code: 'invalid-update' })
      checkForUpdates.mockRejectedValue(new Error('raw transport error with private paths'))
      expect(await Effect.runPromise(Effect.flip(source.driver.check))).toMatchObject({ code: 'check-failed' })
      const notify = vi.fn()
      const unsubscribe = source.driver.subscribeProgress(notify)
      const updater = library.updater as EventEmitter
      updater.emit('download-progress', { percent: 45 })
      unsubscribe()
      updater.emit('download-progress', { percent: 55 })
      expect(notify).toHaveBeenCalledExactlyOnceWith(45)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { isPackaged: false, platform: 'win32' as const, appImage: undefined },
    { isPackaged: true, platform: 'darwin' as const, appImage: undefined },
    { isPackaged: true, platform: 'linux' as const, appImage: undefined },
    { isPackaged: true, platform: 'win32' as const, appImage: undefined },
  ])('falls back safely for $platform packaged=$isPackaged', async options => {
    const result = await Effect.runPromise(
      acquireElectronUpdates({
        ...options,
        appPath: '/missing-watchtower-package',
        executablePath: '/missing-watchtower-package/Watchtower',
        onInstallError: vi.fn(),
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(result.driver).toBeNull()
    expect(result.unavailableReason).toBeTruthy()
  })

  it('disables automatic download/install, prereleases, downgrades, library logging, and identifiers', () => {
    const updater = {} as Parameters<typeof configureElectronUpdater>[0]
    configureElectronUpdater(updater)
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      logger: null,
      requestHeaders: { 'x-user-staging-id': '' },
    })
  })

  it('escapes tags in fallback release URLs', () => {
    expect(releasePageUrl('v0.3.0')).toBe('https://github.com/Pasquale-Favella/watchtower/releases/tag/v0.3.0')
    expect(releasePageUrl('../other')).toContain('..%2Fother')
  })
})

describe('update-aware shutdown', () => {
  it('shares cleanup and starts installation only after cleanup finishes', async () => {
    let finish: () => void = () => {}
    const cleanup = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        }),
    )
    const quit = vi.fn()
    const markQuitting = vi.fn()
    const install = vi.fn()
    const installFailed = vi.fn()
    const coordinator = createQuitCoordinator({ cleanup, quit, markQuitting, installFailed })
    coordinator.requestInstall(install)
    expect(quit).toHaveBeenCalledTimes(1)
    const event = { preventDefault: vi.fn() }
    coordinator.beforeQuit(event)
    coordinator.beforeQuit(event)
    coordinator.requestInstall(vi.fn())
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(markQuitting).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
    finish()
    await Promise.resolve()
    expect(install).toHaveBeenCalledTimes(1)
    expect(installFailed).not.toHaveBeenCalled()
    coordinator.beforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
  })

  it('a normal quit does not install a downloaded update', async () => {
    const quit = vi.fn()
    const coordinator = createQuitCoordinator({
      cleanup: () => Promise.resolve(),
      quit,
      markQuitting: vi.fn(),
      installFailed: vi.fn(),
    })
    coordinator.beforeQuit({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('does not install when cleanup fails', async () => {
    const install = vi.fn()
    const installFailed = vi.fn()
    const coordinator = createQuitCoordinator({
      cleanup: () => Promise.reject(new Error('close failed')),
      quit: vi.fn(),
      markQuitting: vi.fn(),
      installFailed,
    })
    coordinator.requestInstall(install)
    coordinator.beforeQuit({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(install).not.toHaveBeenCalled()
    expect(installFailed).toHaveBeenCalledTimes(1)
  })
})
