import type * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import type * as RpcClient from 'effect/rpc/RpcClient'

import { ApplicationRpcGroup } from '../../../../shared/rpc/application.js'

/** Creates the window's AtomRpc client over its root-owned runtime and protocol layer. */
export function createApplicationAtomRpc<E>(
  runtime: Atom.RegistryRuntimeFactory,
  protocol: Layer.Layer<RpcClient.Protocol, E>,
) {
  class ApplicationAtomRpc extends AtomRpc.Service<ApplicationAtomRpc>()('watchtower/renderer/ApplicationAtomRpc', {
    group: ApplicationRpcGroup,
    protocol,
    runtime,
  }) {}
  return ApplicationAtomRpc
}

export type ApplicationAtomRpc = ReturnType<typeof createApplicationAtomRpc>
