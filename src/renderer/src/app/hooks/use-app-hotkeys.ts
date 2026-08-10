import { useHotkeys } from '@tanstack/react-hotkeys'

import { SHORTCUTS } from '@/app/shortcuts'
import { useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'

/** Shortcut registration, relocated out of AppShell (ADR 0011). Reads
 * navigation + refresh from stores instead of threading callbacks. Registered
 * at shell mount so ⌘R keeps working during the first-hydrate splash. */
export function useAppHotkeys(): void {
  const navigate = useShellStore(s => s.navigate)
  const refresh = useScanStore(s => s.refresh)
  useHotkeys(
    SHORTCUTS.filter(def => def.action !== 'toggleSidebar').map(def => ({
      hotkey: def.hotkey,
      callback: () => {
        if (def.action === 'refresh') {
          void refresh()
        } else if (def.action !== 'toggleSidebar') {
          navigate(def.action)
        }
      },
      options: { meta: { name: def.label, description: def.action } },
    })),
  )
}
