import { ArrowUpRight, NetworkIcon } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'
import type { DelegationWakeMessage } from '@/shared/schemas/delegation.js'

import { delegationStatusLabel } from './delegation-status.js'
import { useOpenDelegatedTask } from './hooks.js'

/**
 * The note a settled Delegated Task leaves in its parent. It is a notice, never a user message:
 * the result text is data for the parent Agent and is not shown as something the user wrote.
 */
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
  const summary = delegation
    ? `Delegated task ${delegation.title} settled as ${delegationStatusLabel(delegation.status).toLowerCase()}`
    : 'A delegated task settled'
  return (
    <article
      aria-label="Delegated task settled"
      className="text-muted-foreground flex min-w-0 items-center gap-2 border-y px-1 py-2 text-xs"
    >
      <NetworkIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 truncate">{summary}</p>
      {delegation && (
        <Button type="button" size="xs" variant="ghost" aria-label={`Open ${delegation.title}`} onClick={onOpen}>
          Open
          <ArrowUpRight aria-hidden="true" />
        </Button>
      )}
    </article>
  )
}
