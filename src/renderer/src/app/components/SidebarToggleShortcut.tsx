import { useHotkey } from '@tanstack/react-hotkeys'

import { useSidebar } from '@/shared/components/ui/sidebar'
import { shortcutForAction } from '@/app/shortcuts'

/** The ⌘B / Ctrl+B sidebar toggle from the shortcuts registry (ADR 0001).
 * Lives inside SidebarProvider so it can reach the sidebar context. */
export function SidebarToggleShortcut() {
  const { toggleSidebar } = useSidebar()
  // The registry is the app's own static table, so 'toggleSidebar' is always present.
  const def = shortcutForAction('toggleSidebar')!
  useHotkey(def.hotkey, () => toggleSidebar(), { meta: { name: def.label, description: def.action } })
  return null
}
