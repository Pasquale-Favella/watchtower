import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { paletteOpenAtom, setPaletteOpenAtom, togglePaletteAtom } from '@/renderer/stores/atoms/palette.js'
import { refreshScanAtom } from '@/renderer/stores/atoms/scan.js'
import { resetSearchAtom, searchTextAtom } from '@/renderer/stores/atoms/search.js'

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
