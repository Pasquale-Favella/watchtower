import type * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import type * as RpcClient from 'effect/rpc/RpcClient'

import { BeaconRpcGroup } from '../../../shared/rpc/application.js'
import { runtime } from '../app/renderer-runtime.js'
import { RendererProtocolLayer } from '../shared/lib/rpc-connection.js'

export function createBeaconRoleClient<E>(
  factory: Atom.RegistryRuntimeFactory,
  protocol: Layer.Layer<RpcClient.Protocol, E>,
) {
  class BeaconRoleRpc extends AtomRpc.Service<BeaconRoleRpc>()('watchtower/renderer/BeaconRoleRpc', {
    group: BeaconRpcGroup,
    protocol,
    runtime: factory,
  }) {}
  return BeaconRoleRpc
}

export const BeaconRoleClient = createBeaconRoleClient(runtime, RendererProtocolLayer)
