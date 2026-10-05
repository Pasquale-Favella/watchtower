import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'
import { displayShortcutForAction } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import { orbControls } from '@/shared/lib/api'
import { formatUsd } from '@/shared/lib/models'
import { cn } from '@/shared/lib/utils'

import { ORB_SIZE } from '../../../shared/schemas/orb.js'
import { useOrbDrag } from './hooks'
import { useOrbStore } from './store'

/** The orb itself: the brand mark in a primary-ringed disc, with a beacon
 * sweeping its rim (faster while a scan runs). Drag to move; click to unfold
 * the spend panel; double-click for the full app. */
export function OrbBeacon({ className }: { className?: string }) {
  const expanded = useOrbStore(s => s.placement.expanded)
  const setExpanded = useOrbStore(s => s.setExpanded)
  const today = useOrbStore(s => s.today.data)
  const scanning = useScanStore(s => s.scanning)
  useSettingsStore(s => s.activeCurrency)
  const drag = useOrbDrag(() => void setExpanded(!expanded))
  const summon = displayShortcutForAction('summonOrb')

  return (
    <button
      type="button"
      aria-label={expanded ? 'Fold Watchtower panel' : 'Show Watchtower panel'}
      // A native title: the 64px window would clip a rendered tooltip.
      title={expanded ? undefined : `${today ? `Today ${formatUsd(today.kpis.cost)}` : 'Watchtower'} · ${summon}`}
      {...drag}
      onDoubleClick={() => orbControls.openApp()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void setExpanded(!expanded)
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
