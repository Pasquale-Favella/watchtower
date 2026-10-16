import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'
import { displayShortcutForAction } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'
import { cn } from '@/shared/lib/utils'

import { ORB_SIZE } from '../../../shared/schemas/orb.js'
import { useOrbDrag } from './beacon-hooks'
import { useOrbPlacementStore } from './placement-store'

/** The orb itself: the brand mark in a primary-ringed disc, with a beacon
 * sweeping its rim (faster while a scan runs — whichever window started it).
 * Drag to move; click to open the spend panel (its own window, beside the
 * orb). It holds no ledger data.
 *
 * A click is its only gesture — deliberately no double-click: every double-
 * click begins with a click that already toggles the panel, and the release
 * of a drag counts as a click too, so "open then quickly fold" and "drag then
 * click" would both reopen the full app by accident. The app opens from the
 * panel's buttons, the summon shortcut pressed twice, or the tray. */
export function OrbBeacon({ className }: { className?: string }) {
  const expanded = useOrbPlacementStore(s => s.placement.expanded)
  const request = useOrbPlacementStore(s => s.request)
  const scanning = useScanStore(s => s.scanning)
  // A click is the user's own request: the panel opens focused.
  const toggle = (): void => void request(expanded ? 'fold' : 'open')
  const drag = useOrbDrag(toggle)
  const summon = displayShortcutForAction('summonOrb')

  return (
    <button
      type="button"
      aria-label={expanded ? 'Fold Watchtower panel' : 'Show Watchtower panel'}
      // A native title: the 64px window would clip a rendered tooltip.
      title={expanded ? undefined : `Watchtower · ${summon}`}
      {...drag}
      // A secondary/middle press is not a toggle (or a drag), but it does take
      // focus from an open panel: fold it rather than strand it unfocused.
      onPointerDownCapture={event => {
        if (event.button !== 0 && expanded) void request('fold')
      }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      }}
      className={cn('grid cursor-grab place-items-center p-1 outline-none active:cursor-grabbing', className)}
      style={{ width: ORB_SIZE, height: ORB_SIZE }}
    >
      <span className="orb-disc bg-card text-primary ring-primary/40 relative grid size-full place-items-center overflow-hidden rounded-full shadow-lg ring-1 transition-transform duration-150 hover:scale-105">
        <span aria-hidden className="orb-beacon absolute inset-0 rounded-full" data-scanning={scanning} />
        <span aria-hidden className="bg-card absolute inset-[3px] rounded-full" />
        <WatchtowerIcon className="relative" size={26} />
      </span>
    </button>
  )
}
