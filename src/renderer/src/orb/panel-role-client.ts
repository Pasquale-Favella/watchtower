import type * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import type * as RpcClient from 'effect/rpc/RpcClient'

import { PanelRpcGroup } from '../../../shared/rpc/application.js'
import { runtime } from '../app/renderer-runtime.js'
import { RendererProtocolLayer } from '../shared/lib/rpc-connection.js'

export function createPanelRoleClient<E>(
  factory: Atom.RegistryRuntimeFactory,
  protocol: Layer.Layer<RpcClient.Protocol, E>,
) {
  class PanelRoleRpc extends AtomRpc.Service<PanelRoleRpc>()('watchtower/renderer/PanelRoleRpc', {
    group: PanelRpcGroup,
    protocol,
    runtime: factory,
  }) {}
  return PanelRoleRpc
}

export const PanelRoleClient = createPanelRoleClient(runtime, RendererProtocolLayer)
