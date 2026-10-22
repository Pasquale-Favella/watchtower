import { RegistryContext } from '@effect/atom-react'
import type { ReactNode } from 'react'

import { useThemeEffect } from '@/app/hooks/use-theme-effect'
import { hydratePreferences, preferencesAtom } from '@/features/settings/preferences-atoms'
import { browserPreferenceStorage } from '@/shared/lib/preferences-browser'
import { themeIsDark } from '@/shared/lib/shell'

import { periodAtom } from './atoms/scope.js'
import { releaseWindowQueries } from './hooks/use-remote-query.js'
import { type RendererRuntimeOwner, rendererRuntimeOwner } from './renderer-runtime.js'

if (import.meta.hot) import.meta.hot.dispose(() => window.location.reload())

/** Called once by each window entry, before React paints or bootstrap reads Scope. */
export function initializeRendererWindow(
  browser: Window,
  owner: RendererRuntimeOwner = rendererRuntimeOwner,
): () => void {
  const storage = browserPreferenceStorage(browser)
  const { registry } = owner
  const unsubscribe = hydratePreferences(registry, storage)
  const preferences = registry.get(preferencesAtom)
  registry.set(periodAtom, preferences.defaultPeriod)
  browser.document.documentElement.classList.toggle(
    'dark',
    themeIsDark(preferences.theme, browser.matchMedia('(prefers-color-scheme: dark)').matches),
  )
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    browser.removeEventListener('beforeunload', dispose)
    unsubscribe()
    releaseWindowQueries(registry)
    owner.dispose()
  }
  browser.addEventListener('beforeunload', dispose)
  return dispose
}

export interface RendererRootProps {
  readonly children: ReactNode
}

export function RendererRoot({ children }: RendererRootProps) {
  return (
    <RegistryContext.Provider value={rendererRuntimeOwner.registry}>
      {children}
      <ThemeSync />
    </RegistryContext.Provider>
  )
}

function ThemeSync() {
  useThemeEffect()
  return null
}
