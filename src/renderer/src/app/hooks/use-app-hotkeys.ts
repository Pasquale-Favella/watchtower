import { useAtomSet } from '@effect/atom-react'
import { useHotkeys } from '@tanstack/react-hotkeys'

import { togglePaletteAtom } from '@/app/atoms/palette'
import { refreshScanAtom } from '@/app/atoms/scan'
import { navigateToSection } from '@/app/navigation'
import { SHORTCUTS } from '@/app/shortcuts'

/** Shortcut registration, relocated out of AppRoot (ADR 0011). Section
 * actions navigate through the module-level app/navigation.ts (ADR 0014);
 * refresh reads from the scan store; commandPalette (ADR 0028) toggles the
 * palette store. Registered at root mount so ⌘R keeps
 * working during the first-hydrate splash. */
export function useAppHotkeys(): void {
  const refresh = useAtomSet(refreshScanAtom)
  const togglePalette = useAtomSet(togglePaletteAtom)
  useHotkeys(
    // `global` shortcuts are the main process's (OS-wide), not this window's.
    SHORTCUTS.filter(def => def.action !== 'toggleSidebar' && def.scope !== 'global').map(def => ({
      hotkey: def.hotkey,
      callback: () => {
        switch (def.action) {
          case 'refresh':
            refresh(undefined)
            break
          case 'commandPalette':
            togglePalette(undefined)
            break
          case 'toggleSidebar':
            break // owned by SidebarToggleShortcut, filtered above
          case 'summonOrb':
            // Never reached (global entries are filtered above) — kept so the
            // `default` branch's action narrows to a Section.
            break
          default:
            navigateToSection(def.action)
        }
      },
      options: { meta: { name: def.label, description: def.action } },
    })),
  )
}
