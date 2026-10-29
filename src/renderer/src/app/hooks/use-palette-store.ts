import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { paletteOpenAtom, setPaletteOpenAtom, togglePaletteAtom } from '../atoms/palette.js'
import { refreshScanAtom } from '../atoms/scan.js'
import { resetSearchAtom, searchTextAtom } from '../atoms/search.js'

export function usePaletteStore() {
  const open = useAtomValue(paletteOpenAtom)
  const setOpen = useAtomSet(setPaletteOpenAtom)
  const togglePalette = useAtomSet(togglePaletteAtom)
  const refreshScan = useAtomSet(refreshScanAtom)
  const searchText = useAtomValue(searchTextAtom)
  const setSearchText = useAtomSet(searchTextAtom)
  const resetSearch = useAtomSet(resetSearchAtom)

  return { open, setOpen, togglePalette, refreshScan, searchText, setSearchText, resetSearch }
}
