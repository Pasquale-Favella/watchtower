import { useAtomSet } from '@effect/atom-react'

import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { useScopeStore } from '@/stores/hooks/use-scope-store'
import { modelsQuery } from '@/features/models/atoms'
import { removeAliasAtom, removeOverrideAtom } from '@/features/models/pricing-atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function useModelsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(modelsQuery, scope, keyOfScope)
  const removeAlias = useAtomSet(removeAliasAtom, { mode: 'promise' })
  const removeOverride = useAtomSet(removeOverrideAtom, { mode: 'promise' })
  return { ...query, provider, setProvider, detectedProviders, removeAlias, removeOverride }
}
