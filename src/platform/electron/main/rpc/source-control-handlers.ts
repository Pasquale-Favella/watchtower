import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { CommandRunner } from '@/core/ports/process.js'
import { discoverSourceControl } from '@/infrastructure/filesystem/source-control-discovery.js'
import { SourceControlRpcGroup } from '@/shared/rpc/source-control.js'

/** Read-only discovery of Git and the GitHub CLI. Each call spawns the tools again: sign-in changes outside the app. */
export const sourceControlHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    return SourceControlRpcGroup.toLayer({
      'sourceControl:discover': () => discoverSourceControl.pipe(Effect.provideService(CommandRunner, runner)),
    })
  }),
)
