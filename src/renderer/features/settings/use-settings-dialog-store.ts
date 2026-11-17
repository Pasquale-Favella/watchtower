import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback } from 'react'

import {
  selectSettingsGroupAtom,
  selectSettingsPaneAtom,
  setSettingsOpenAtom,
  settingsDialogAtom,
} from './dialog-atoms.js'

export function useSettingsDialogStore() {
  const state = useAtomValue(settingsDialogAtom)
  const setOpen = useAtomSet(setSettingsOpenAtom)
  const selectGroup = useAtomSet(selectSettingsGroupAtom)
  const selectPane = useAtomSet(selectSettingsPaneAtom)
  const showSettings = useCallback(() => setOpen(true), [setOpen])
  return { ...state, setOpen, showSettings, selectGroup, selectPane }
}
