import type { ConversationActivity } from '../conversation-view.js'
import { formatRunDuration } from './duration.js'
import { useElapsedMs } from './use-elapsed.js'

const activityLabels: Readonly<Record<ConversationActivity['label'], string>> = {
  working: 'Working…',
  thinking: 'Thinking…',
  awaitingAnswer: 'Waiting for your answer',
  awaitingApproval: 'Waiting for approval',
}

/** The live row after the latest item while a Run has not settled. The ticker only runs while it is shown. */
export function ActivityRow({ activity }: { readonly activity: ConversationActivity }): React.JSX.Element {
  const waiting = activity.label === 'awaitingAnswer' || activity.label === 'awaitingApproval'
  const elapsed = useElapsedMs(activity.since, !waiting)
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-sm">
      <span
        aria-hidden
        className={waiting ? 'bg-warning size-1.5 rounded-full' : 'bg-primary size-1.5 animate-pulse rounded-full'}
      />
      <span>{activityLabels[activity.label]}</span>
      {elapsed !== null && <span className="text-xs tabular-nums">{formatRunDuration(elapsed)}</span>}
    </div>
  )
}
