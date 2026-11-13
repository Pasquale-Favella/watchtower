import { createContext } from 'react'

export const WorkspaceQueryScopeContext = createContext<ReadonlyMap<object, object> | null>(null)
