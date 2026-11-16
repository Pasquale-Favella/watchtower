import { useHotkeys } from '@tanstack/react-hotkeys'

import { shortcutForAction } from '@/renderer/app/shortcuts'
import { useSettingsDialogStore } from '@/renderer/features/settings/use-settings-dialog-store'

/** Opens Settings from either application vertical. */
export function useSettingsHotkey(): void {
  const { showSettings } = useSettingsDialogStore()
  const shortcut = shortcutForAction('settings')

  useHotkeys(
    shortcut
      ? [
          {
            hotkey: shortcut.hotkey,
            callback: showSettings,
            options: { meta: { name: shortcut.label, description: shortcut.action } },
          },
        ]
      : [],
  )
}
