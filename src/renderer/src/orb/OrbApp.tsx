import { useThemeEffect } from '@/app/hooks/use-theme-effect'

import { useOrbBeaconBootstrap } from './hooks'
import { OrbBeacon } from './OrbBeacon'

/**
 * The orb window's composition root (see main/background-shell.ts): just the
 * 64px orb. Its window never resizes, and it holds no ledger data — the spend
 * panel is its own window (`OrbPanelApp`). (ADR 0011)
 */
export function OrbApp() {
  useOrbBeaconBootstrap()
  useThemeEffect()
  return (
    <div className="text-foreground h-full w-full font-sans">
      <OrbBeacon />
    </div>
  )
}
