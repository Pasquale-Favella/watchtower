import { useHotkeys } from '@tanstack/react-hotkeys'

import { SHORTCUTS } from '@/app/shortcuts'
import { navigateToSection } from '@/app/navigation'
import { usePaletteStore } from '@/app/stores/palette-store'
import { useScanStore } from '@/app/stores/scan-store'

/** Shortcut registration, relocated out of AppRoot (ADR 0011). Section
 * actions navigate through the module-level app/navigation.ts (ADR 0014);
 * refresh reads from the scan store; commandPalette (ADR 0028) toggles the
 * palette store. Registered at root mount so ⌘R keeps
 * working during the first-hydrate splash. */
export function useAppHotkeys(): void {
  const refresh = useScanStore(s => s.refresh)
  const togglePalette = usePaletteStore(s => s.toggle)
  useHotkeys(
    // `global` shortcuts are the main process's (OS-wide), not this window's.
    SHORTCUTS.filter(def => def.action !== 'toggleSidebar' && def.scope !== 'global').map(def => ({
      hotkey: def.hotkey,
      callback: () => {
        switch (def.action) {
          case 'refresh':
            void refresh()
            break
          case 'commandPalette':
            togglePalette()
            break
          case 'toggleSidebar':
            break // owned by SidebarToggleShortcut, filtered above
          case 'summonOrb':
            break // global: registered by the main process, filtered above
          default:
            navigateToSection(def.action)
        }
      },
      options: { meta: { name: def.label, description: def.action } },
    })),
  )
}
