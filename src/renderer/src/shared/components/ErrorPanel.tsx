import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

/** Shared renderer error state (ticket 09): the single visible panel a view
 * renders when an IPC payload fails validation or the IPC call itself rejects.
 * No view paints garbage or crashes on a bad payload — it shows this. */
export function ErrorPanel({ message, className }: { message: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn('rounded-lg border border-border bg-card px-3.5 py-6 text-[12px] text-muted-foreground', className)}>
      {message}
    </div>
  )
}
