import { useAtomSet } from '@effect/atom-react'

import { openExternalAtom } from '../lib/native-capabilities.js'

export function useNativeStore() {
  const openExternal = useAtomSet(openExternalAtom)

  return { openExternal }
}
