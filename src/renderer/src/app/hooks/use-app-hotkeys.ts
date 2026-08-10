import { useHotkeys } from '@tanstack/react-hotkeys'

import { SHORTCUTS } from '@/app/shortcuts'
import { navigateToSection } from '@/app/navigation'
import { useScanStore } from '@/app/stores/scan-store'

/** Shortcut registration, relocated out of AppRoot (ADR 0011). Section
 * actions navigate through the module-level app/navigation.ts (ADR 0014);
 * refresh reads from the scan store. Registered at root mount so ⌘R keeps
 * working during the first-hydrate splash. */
export function useAppHotkeys(): void {
  const refresh = useScanStore(s => s.refresh)
  useHotkeys(
    SHORTCUTS.filter(def => def.action !== 'toggleSidebar').map(def => ({
      hotkey: def.hotkey,
      callback: () => {
        if (def.action === 'refresh') {
          void refresh()
        } else if (def.action !== 'toggleSidebar') {
          navigateToSection(def.action)
        }
      },
      options: { meta: { name: def.label, description: def.action } },
    })),
  )
}
