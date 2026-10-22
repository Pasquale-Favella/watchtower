import { useAtomValue } from '@effect/atom-react'
import { useEffect } from 'react'

import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { themeIsDark } from '@/shared/lib/shell'

/** The theme DOM side-effect, relocated out of AppRoot (ADR 0011):
 * toggles the `dark` class from the settings store's persisted `theme`, and
 * follows the OS while in 'system' mode. The persist middleware owns the
 * storage write — no hand-rolled localStorage here. */
export function useThemeEffect(): void {
  const theme = useAtomValue(preferencesAtom).theme
  useEffect(() => {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    document.documentElement.classList.toggle('dark', themeIsDark(theme, prefersDark))
    if (theme === 'system') {
      const media = window.matchMedia?.('(prefers-color-scheme: dark)')
      const onChange = (event: MediaQueryListEvent): void => {
        document.documentElement.classList.toggle('dark', themeIsDark(theme, event.matches))
      }
      media?.addEventListener('change', onChange)
      return () => media?.removeEventListener('change', onChange)
    }
    return undefined
  }, [theme])
}
