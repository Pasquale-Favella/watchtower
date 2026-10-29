import { useAtomValue } from '@effect/atom-react'
import { useEffect } from 'react'

import { preferencesAtom } from '@/renderer/features/settings/preferences-atoms'
import { themeIsDark } from '@/renderer/shared/lib/shell'

/** The window root owns theme updates and the scoped system appearance listener. */
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
