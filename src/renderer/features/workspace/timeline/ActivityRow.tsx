import { BrainIcon, LoaderCircleIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from 'lucide-react'

import type { ConversationActivity } from '../conversation-view.js'
import { formatRunDuration } from './duration.js'
import { useElapsedMs } from './use-elapsed.js'

const activityLabels: Readonly<Record<ConversationActivity['label'], string>> = {
  working: 'Working…',
  thinking: 'Thinking…',
  awaitingAnswer: 'Waiting for your answer',
  awaitingApproval: 'Waiting for approval',
}

const activityIcons = {
  working: LoaderCircleIcon,
  thinking: BrainIcon,
  awaitingAnswer: MessageCircleQuestionIcon,
  awaitingApproval: ShieldQuestionIcon,
} as const

/** The live row after the latest item while a Run has not settled. The ticker only runs while it is shown. */
export function ActivityRow({ activity }: { readonly activity: ConversationActivity }): React.JSX.Element {
  const waiting = activity.label === 'awaitingAnswer' || activity.label === 'awaitingApproval'
  const elapsed = useElapsedMs(activity.since, !waiting)
  const Icon = activityIcons[activity.label]
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-sm">
      <Icon
        aria-hidden
        className={waiting ? 'text-warning size-3.5' : 'text-primary size-3.5 motion-safe:animate-pulse'}
      />
      <span role="status" aria-live="polite">
        {activityLabels[activity.label]}
      </span>
      {elapsed !== null && (
        <span aria-label="Elapsed time" className="text-xs tabular-nums">
          {formatRunDuration(elapsed)}
        </span>
      )}
    </div>
  )
}
