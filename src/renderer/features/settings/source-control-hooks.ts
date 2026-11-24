import { useAtomSet } from '@effect/atom-react'
import { useEffect } from 'react'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'

const REQUEST = {}
const key = () => 'source-control-discovery'
const discovery = createRpcQuerySlot({
  key,
  query: (_: typeof REQUEST, serializationKey: string) =>
    ApplicationClient.query('sourceControl:discover', {}, { serializationKey }),
})

/**
 * What Git and the GitHub CLI report on this computer. It is read when the pane opens and again whenever the window
 * regains focus, since both tools change outside the application; there is no polling.
 */
export function useSourceControlDiscovery() {
  const query = useRemoteQuery(discovery, REQUEST, key)
  const refresh = useAtomSet(discovery.refreshAtom)
  useEffect(() => {
    const rescan = () => refresh(undefined)
    rescan()
    window.addEventListener('focus', rescan)
    return () => window.removeEventListener('focus', rescan)
  }, [refresh])
  return { ...query, rescan: () => refresh(undefined) }
}
