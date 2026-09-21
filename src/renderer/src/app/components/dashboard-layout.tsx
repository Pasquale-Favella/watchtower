import { Outlet } from '@tanstack/react-router'

import { StatusBar } from '@/app/components/StatusBar'
import { TopBar } from '@/app/components/TopBar'
import { motionClass } from '@/shared/lib/motion'

/** The dashboard layout route (ADR 0014): the TopBar/scroll-region/StatusBar
 * strip around the seven section views. Settings is full-bleed (its own
 * header and nav rail) and skips this strip. */
export function DashboardLayout() {
  return (
    <>
      <TopBar />
      <div
        data-section-scroll
        className={motionClass('flex min-h-0 flex-1 flex-col items-center overflow-y-auto gap-4 px-5 pt-4 pb-4', 'section-fade')}
      >
        <Outlet />
      </div>
      <StatusBar />
    </>
  )
}
