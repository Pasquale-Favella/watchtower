import { BrainIcon, LoaderCircleIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from 'lucide-react'

import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/renderer/components/ui/trace'

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
    <Trace className="px-1">
      <TraceLine status={waiting ? undefined : 'running'}>
        <TraceIcon className={waiting ? 'text-warning' : undefined}>
          <Icon className={activity.label === 'working' ? 'size-3.5 motion-safe:animate-spin' : 'size-3.5'} />
        </TraceIcon>
        <TraceTitle role="status" aria-live="polite">
          {activityLabels[activity.label]}
        </TraceTitle>
        {elapsed !== null && (
          <TraceDescription aria-label="Elapsed time" className="text-xs">
            {formatRunDuration(elapsed)}
          </TraceDescription>
        )}
      </TraceLine>
    </Trace>
  )
}
