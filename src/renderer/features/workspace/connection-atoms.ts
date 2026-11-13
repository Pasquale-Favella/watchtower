import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

import { keepAliveFamily } from './model-picker/inspection-family.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

/** One inspection per connection, kept for the app session. Reading a member starts its inspection once. */
export const connectionInspectionAtom = keepAliveFamily((connectionId: string) =>
  runtime.atom(
    Effect.gen(function* () {
      const client = yield* ApplicationClient
      return yield* client('workspace:inspectConnection', { connectionId })
    }),
  ),
)

/** Stands in for a connection that is not yet known, so no inspection is started for it. */
export const idleConnectionInspectionAtom = Atom.make(AsyncResult.initial<WorkspaceConnectionInspection, unknown>())

/** The connection that caller-level inspection reports on. Empty until a caller names one. */
export const inspectionFocusAtom = Atom.keepAlive(Atom.make(''))
