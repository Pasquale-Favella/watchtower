import { RegistryContext } from '@effect/atom-react'
import { useContext, useEffect } from 'react'

import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { sessionQuery } from '@/features/sessions/atoms'
import { useNativeStore } from '@/shared/hooks/use-native-store'
import type { SessionRequest } from '@/shared/lib/query-keys'
import { sessionRequestKey } from '@/shared/lib/query-keys'

export function useSessionStore(request: SessionRequest | null) {
  const query = useRemoteQuery(sessionQuery, request, sessionRequestKey)
  const { openExternal } = useNativeStore()
  const registry = useContext(RegistryContext)
  useEffect(() => () => registry.set(sessionQuery.resetAtom, undefined), [registry])
  return { ...query, openExternal }
}
