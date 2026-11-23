import { BotIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'

import { TextTooltip } from '@/renderer/components/ui/tooltip'
import type { DelegationStatus, DelegationWakeMessage } from '@/shared/schemas/delegation.js'

import { useOpenDelegatedTask } from './hooks.js'

const statusPhrases: Record<DelegationStatus, string> = {
  queued: 'is queued',
  running: 'is running',
  waiting: 'is waiting',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'was stopped',
  cancelled: 'was stopped',
  uncertain: 'needs attention',
}

export function DelegationWakeNotice({
  delegation,
}: {
  readonly delegation: DelegationWakeMessage | undefined
}): React.JSX.Element {
  const openTask = useOpenDelegatedTask()
  const onOpen = () => {
    if (delegation) openTask(delegation.childTaskId)
  }
  return <DelegationWakeNoticeView delegation={delegation} onOpen={onOpen} />
}

export function DelegationWakeNoticeView({
  delegation,
  onOpen,
}: {
  readonly delegation: DelegationWakeMessage | undefined
  readonly onOpen: () => void
}): React.JSX.Element {
  const className =
    'text-muted-foreground flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs'
  if (!delegation) {
    return (
      <div className={className}>
        <BotIcon aria-hidden className="size-3.5 shrink-0" />A delegated task settled
      </div>
    )
  }
  const summary = `${delegation.title} ${statusPhrases[delegation.status]}`
  const Icon = delegation.status === 'completed' ? BotIcon : CircleAlertIcon
  return (
    <TextTooltip
      label={summary}
      trigger={
        <button
          type="button"
          className={`${className} hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring focus-visible:ring-2`}
          onClick={onOpen}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
        </button>
      }
    />
  )
}
