import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { useCallback, useContext, useMemo } from 'react'

import { runtime } from '@/renderer/app/renderer-runtime.js'

import { runWorkspaceOperation } from '../../workspace-operation.js'
import {
  type CallOptions,
  makeWorkerClient,
  type MethodContracts,
  type Methods,
  WorkerRpcError,
} from './office/worker-rpc.js'

const workerRuntime = runtime(Layer.empty)

/** Acquires a native worker through the window's Atom Scope; React only consumes results and commands. */
export function usePreviewWorker<M extends Methods>(factory: () => Worker, contracts: MethodContracts<M>) {
  const registry = useContext(RegistryContext)
  const resource = useMemo(
    () =>
      workerRuntime.atom(
        Effect.try({
          try: factory,
          catch: () => new WorkerRpcError({ code: 'failed', message: 'The preview worker could not start.' }),
        }).pipe(Effect.flatMap(worker => makeWorkerClient<M>(worker, contracts))),
      ),
    [contracts, factory],
  )
  const state = useAtomValue(resource)
  const call = useCallback(
    <K extends keyof M & string>(
      method: K,
      input: M[K]['input'],
      options: CallOptions = {},
    ): Promise<M[K]['output']> => {
      const command = () =>
        workerRuntime.fn<undefined>()(() =>
          AtomRegistry.getResult(registry, resource).pipe(
            Effect.flatMap(client => client.call(method, input, options)),
          ),
        )
      return runWorkspaceOperation(registry, command, undefined)
    },
    [registry, resource],
  )
  return {
    call,
    pending: state._tag === 'Initial',
    error: state._tag === 'Failure' ? 'The preview worker is unavailable.' : null,
  }
}
