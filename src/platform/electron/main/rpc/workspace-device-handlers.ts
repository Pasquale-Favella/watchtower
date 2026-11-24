import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { dialog } from 'electron'

import { WorkspaceDevices } from '@/core/ports/workspace-devices.js'
import { WorkspaceDeviceRpcGroup } from '@/shared/rpc/workspace-devices.js'
import { WorkspaceDeviceError, workspaceDeviceMessages } from '@/shared/schemas/workspace-devices.js'

function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WorkspaceDeviceError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const error = Cause.findError(cause)
      if (error._tag === 'Success' && Schema.is(WorkspaceDeviceError)(error.success)) return Effect.fail(error.success)
      return Effect.fail(
        new WorkspaceDeviceError({ code: 'command-failed', message: workspaceDeviceMessages['command-failed'] }),
      )
    }),
  )
}

export function workspaceDeviceHandlers() {
  return Layer.unwrap(
    Effect.gen(function* () {
      const devices = yield* WorkspaceDevices
      return WorkspaceDeviceRpcGroup.toLayer({
        'devices:connect': request => safe(devices.connect(request.address)),
        'devices:list': () => safe(devices.list),
        'devices:boot': request => safe(devices.boot(request)),
        'devices:shutdown': request => safe(devices.shutdown(request)),
        'devices:screenshot': request => safe(devices.screenshot(request)),
        'devices:action': request => safe(devices.action(request)),
        'devices:install': request =>
          safe(
            Effect.gen(function* () {
              const picked = yield* Effect.tryPromise(() =>
                dialog.showOpenDialog(
                  request.platform === 'android'
                    ? {
                        title: 'Install Android app',
                        properties: ['openFile'],
                        filters: [{ name: 'Android application', extensions: ['apk'] }],
                      }
                    : { title: 'Install iOS simulator app', properties: ['openDirectory'] },
                ),
              )
              const path = picked.filePaths[0]
              if (picked.canceled || !path) return { installed: false }
              yield* devices.install(request, path)
              return { installed: true }
            }),
          ),
      })
    }),
  )
}
