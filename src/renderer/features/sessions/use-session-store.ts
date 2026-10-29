import { RegistryContext } from '@effect/atom-react'
import { useContext, useEffect } from 'react'

import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { sessionQuery } from '@/renderer/features/sessions/atoms'
import { useNativeStore } from '@/renderer/shared/hooks/use-native-store'
import type { SessionRequest } from '@/renderer/shared/lib/query-keys'
import { sessionRequestKey } from '@/renderer/shared/lib/query-keys'

export function useSessionStore(request: SessionRequest | null) {
  const query = useRemoteQuery(sessionQuery, request, sessionRequestKey)
  const { openExternal } = useNativeStore()
  const registry = useContext(RegistryContext)
  useEffect(() => () => registry.set(sessionQuery.resetAtom, undefined), [registry])
  return { ...query, openExternal }
}
