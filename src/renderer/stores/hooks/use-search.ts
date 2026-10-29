import { useAtomValue } from '@effect/atom-react'
import { useMemo } from 'react'

import type { OverviewScope } from '@/shared/schemas/overview.js'
import { overviewScopeAtom } from '@/renderer/stores/atoms/scope.js'
import { debouncedSearchTextAtom, paletteSearchKey, searchSlot } from '@/renderer/stores/atoms/search.js'
import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'

export function paletteSearchRequest(open: boolean, input: string, debounced: string, scope: OverviewScope) {
  const query = input.trim()
  const settledQuery = debounced.trim()
  return open && query.length > 0 && query === settledQuery ? { query, scope } : null
}

/** Activates session search only for an open palette and a settled input. */
export function usePaletteSearch(open: boolean, input: string) {
  const debounced = useAtomValue(debouncedSearchTextAtom)
  const scope = useAtomValue(overviewScopeAtom)
  const request = useMemo(() => paletteSearchRequest(open, input, debounced, scope), [open, input, debounced, scope])
  return { ...useRemoteQuery(searchSlot, request, paletteSearchKey), active: request !== null }
}
