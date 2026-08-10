import { Outlet } from '@tanstack/react-router'
import { useAppBootstrap } from './hooks/use-app-bootstrap'
import { useThemeEffect } from './hooks/use-theme-effect'
import { useAppHotkeys } from './hooks/use-app-hotkeys'
import { Splash } from './components/Splash'
import { Onboarding } from './components/Onboarding'
import { useScanStore } from './stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'

/** The app root route component (ADR 0014): the bootstrap, theme, and hotkey
 * concerns live in hooks; the JSX is the router's `Outlet` (shell layout and
 * every section). The shell only decides splash-vs-app and mounts the
 * onboarding tour — every piece of data reads from a store. */
export function AppShell() {
  useAppBootstrap()
  useThemeEffect()
  useAppHotkeys()

  const hydrated = useScanStore(s => s.hydrated)
  const onboarded = useSettingsStore(s => s.onboarded)

  if (!hydrated) {
    return <Splash />
  }

  return (
    <>
      <Outlet />
      {!onboarded && <Onboarding />}
    </>
  )
}
