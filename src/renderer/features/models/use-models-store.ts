import { useAtomSet } from '@effect/atom-react'

import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import { modelsQuery } from '@/renderer/features/models/atoms'
import { removeAliasAtom, removeOverrideAtom } from '@/renderer/features/models/pricing-atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function useModelsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(modelsQuery, scope, keyOfScope)
  const removeAlias = useAtomSet(removeAliasAtom, { mode: 'promise' })
  const removeOverride = useAtomSet(removeOverrideAtom, { mode: 'promise' })
  return { ...query, provider, setProvider, detectedProviders, removeAlias, removeOverride }
}
