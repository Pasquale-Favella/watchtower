import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { shell, type WebContents } from 'electron'

import { OrbRpcGroup, ShellRpcError, ShellRpcGroup } from '../../../../shared/rpc/shell.js'
import { BackgroundShell } from '../background-shell.js'
import { safeLogOperationalEvent } from '../../../../infrastructure/logging/operational-log.js'

const unavailable = () => new ShellRpcError({ code: 'unavailable', message: 'Shell unavailable' })

/** Every native operation remains under its existing owner and authenticated connection. */
export function shellHandlers(sender: WebContents) {
  const commands = Semaphore.makeUnsafe(1)
  return ShellRpcGroup.merge(OrbRpcGroup).toLayer({
    'shell:events': () => Stream.unwrap(Effect.map(BackgroundShell, owner => owner.events(sender))),
    'shell:notice': notice =>
      Effect.sync(() => {
        safeLogOperationalEvent('warn', 'renderer.notice', notice, 'renderer')
      }),
    'shell:open-external': ({ url }) =>
      Effect.gen(function* () {
        const parsed = URL.canParse(url) ? new URL(url) : undefined
        if (parsed?.protocol !== 'https:' && parsed?.protocol !== 'http:') return
        yield* Effect.tryPromise({ try: () => shell.openExternal(url), catch: unavailable })
      }),
    'shell:open-settings': () =>
      Effect.gen(function* () {
        if (process.platform !== 'darwin') return false
        yield* Effect.tryPromise({
          try: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'),
          catch: unavailable,
        })
        return true
      }),
    'orb:placement': () => Effect.flatMap(BackgroundShell, owner => Effect.sync(() => owner.placement(sender))),
    'orb:command': command =>
      commands.withPermit(
        Effect.flatMap(BackgroundShell, owner =>
          Effect.try({
            try: () => owner.command(sender, command),
            catch: error => (error instanceof ShellRpcError ? error : unavailable()),
          }),
        ),
      ),
  })
}
