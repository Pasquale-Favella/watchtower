import { RegistryContext } from '@effect/atom-react'
import { useCallback, useContext } from 'react'

import { runWorkspaceOperation, type WorkspaceOperation } from './workspace-operation.js'

export function useWorkspaceOperation<Input, Value, Error>(makeAtom: WorkspaceOperation<Input, Value, Error>) {
  const registry = useContext(RegistryContext)
  return useCallback((request: Input) => runWorkspaceOperation(registry, makeAtom, request), [registry, makeAtom])
}
