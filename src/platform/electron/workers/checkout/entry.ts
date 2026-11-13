import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'

import { CheckoutInspection } from '@/core/ports/checkout-inspection.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { CheckoutInspectionLive } from '@/infrastructure/workspace/checkout-inspector.js'

import { CheckoutWorkerRpc } from './protocol.js'

const inspection = CheckoutInspectionLive.pipe(Layer.provideMerge(CommandRunnerLive), Layer.provide(NodePlatformLive))
const handlers = CheckoutWorkerRpc.toLayer({
  'inspect:diff': request => CheckoutInspection.use(service => service.diffPreview(request.root, request.source)),
  'inspect:patch': request => CheckoutInspection.use(service => service.filePatch(request.root, request.request)),
  'inspect:branches': request => CheckoutInspection.use(service => service.branches(request.root)),
  'inspect:commits': request => CheckoutInspection.use(service => service.commits(request.root)),
  'inspect:entries': request =>
    CheckoutInspection.use(service => service.listEntries(request.root, request.path, request)),
  'inspect:read': request => CheckoutInspection.use(service => service.readFile(request.root, request.path, request)),
  'inspect:write': request => CheckoutInspection.use(service => service.writeFile(request.root, request)),
}).pipe(Layer.provide(inspection))

NodeRuntime.runMain(
  RpcServer.make(CheckoutWorkerRpc, { concurrency: 4 }).pipe(
    Effect.provide(handlers),
    Effect.provide(RpcServer.layerProtocolWorkerRunner),
    Effect.provide(NodeWorkerRunner.layer),
  ),
  { disableErrorReporting: true },
)
