import { dirname, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import electronUpdater, { type AppUpdater, type ProgressInfo } from 'electron-updater'

import { UpdateError, type UpdateSource } from './updates.js'

const metadataSchema = Schema.fromJsonString(
  Schema.Struct({
    watchtowerSignedUpdates: Schema.optional(Schema.Boolean),
  }),
)
const versionSchema = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))

export interface ElectronUpdatesOptions {
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
  readonly appPath: string
  readonly executablePath: string
  readonly appImage: string | undefined
  readonly onInstallError: () => void
}

/** Keep the public provider unauthenticated and suppress its staging identifier. */
export function configureElectronUpdater(updater: AppUpdater): void {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.disableWebInstaller = true
  updater.logger = null
  updater.requestHeaders = { 'x-user-staging-id': '' }
}

export const acquireElectronUpdates = Effect.fn('acquireElectronUpdates')(function* (
  options: ElectronUpdatesOptions,
): Effect.fn.Return<UpdateSource, never, FileSystem.FileSystem> {
  const unavailable = (unavailableReason: string): UpdateSource => ({ driver: null, unavailableReason })
  if (!options.isPackaged)
    return unavailable(
      'In-app updates are available in installed releases. Open the release page to download Watchtower.',
    )
  const fs = yield* FileSystem.FileSystem
  if (options.platform === 'darwin') {
    const metadata = yield* fs.readFileString(join(options.appPath, 'package.json')).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(metadataSchema)),
      Effect.orElseSucceed(() => ({ watchtowerSignedUpdates: false })),
    )
    if (!metadata.watchtowerSignedUpdates)
      return unavailable('This macOS build uses ad-hoc signing. Download updates from the release page.')
  } else if (options.platform === 'linux') {
    if (!options.appImage)
      return unavailable(
        'Use your package manager or download a new artifact from the release page. In-app Linux updates require AppImage.',
      )
  } else if (options.platform === 'win32') {
    const installed = yield* fs
      .exists(join(dirname(options.executablePath), 'Uninstall Watchtower.exe'))
      .pipe(Effect.orElseSucceed(() => false))
    if (!installed) return unavailable('Install Watchtower with the Windows setup artifact to enable in-app updates.')
  } else return unavailable('Download updates for this platform from the release page.')

  return yield* Effect.try({
    try: (): UpdateSource => {
      const updater = electronUpdater.autoUpdater
      configureElectronUpdater(updater)
      return {
        unavailableReason: null,
        driver: {
          check: Effect.tryPromise({
            try: () => updater.checkForUpdates(),
            catch: () => new UpdateError({ code: 'check-failed' }),
          }).pipe(
            Effect.flatMap(result => {
              if (!result) return Effect.fail(new UpdateError({ code: 'check-failed' }))
              return Schema.decodeUnknownEffect(versionSchema)(result.updateInfo.version).pipe(
                Effect.map(version => ({ version, available: result.isUpdateAvailable })),
                Effect.mapError(() => new UpdateError({ code: 'invalid-update' })),
              )
            }),
          ),
          download: Effect.tryPromise({
            try: signal => {
              const token = new electronUpdater.CancellationToken()
              const cancel = (): void => token.cancel()
              signal.addEventListener('abort', cancel, { once: true })
              return updater.downloadUpdate(token).finally(() => signal.removeEventListener('abort', cancel))
            },
            catch: () => new UpdateError({ code: 'download-failed' }),
          }).pipe(Effect.asVoid),
          subscribeProgress: notify => {
            const onProgress = (info: ProgressInfo): void => notify(info.percent)
            updater.on('download-progress', onProgress)
            return () => updater.removeListener('download-progress', onProgress)
          },
          install: () => {
            updater.once('error', options.onInstallError)
            updater.quitAndInstall(false, true)
          },
        },
      }
    },
    catch: () => new UpdateError({ code: 'check-failed' }),
  }).pipe(
    Effect.orElseSucceed(() => unavailable('The updater could not start. Download updates from the release page.')),
  )
})
