import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

export const inspectWorkspaceConnectionAtom = Atom.keepAlive(
  runtime.fn<{ readonly connectionId: string }>()(({ connectionId }) =>
    Effect.gen(function* () {
      const client = yield* ApplicationClient
      return yield* client('workspace:inspectConnection', { connectionId })
    }),
  ),
)
