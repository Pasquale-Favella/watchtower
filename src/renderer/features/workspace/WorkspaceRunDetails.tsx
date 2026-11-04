import type { ReactNode } from 'react'

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/renderer/components/ui/sheet'
import type { ConversationId } from '@/shared/schemas/workspace.js'
import type { WorkspaceTaskDetail } from '@/shared/schemas/workspace-store.js'

import { currentConversationRuns } from './composer-state.js'
import { useWorkspaceTaskSnapshot } from './hooks.js'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly task?: WorkspaceTaskDetail['task']
  readonly conversationId?: ConversationId | null
  readonly children?: ReactNode
}

export function WorkspaceRunDetails({ open, onOpenChange, task, conversationId, children }: Props): React.JSX.Element {
  const snapshot = useWorkspaceTaskSnapshot(task ? { taskId: task.id, runLimit: 100 } : null)
  const runs = conversationId
    ? currentConversationRuns(snapshot.data?.runs ?? [], snapshot.data?.runContexts ?? [], conversationId)
    : []
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-y-auto p-0">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Agent run details</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 p-4 text-sm">
          {task ? (
            <div className="space-y-2">
              <p className="font-medium break-words">{task.title}</p>
              <p className="text-muted-foreground">{task.status}</p>
              {task.description && <p className="break-words">{task.description}</p>}
              {task.payloadRef && (
                <p className="text-muted-foreground text-xs">
                  Task details are summarized; full details remain stored locally.
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">Send a message to start an agent run.</p>
          )}
          {children}
          {snapshot.error && (
            <p role="alert" className="text-destructive">
              {snapshot.error}
            </p>
          )}
          {task && !snapshot.data && !snapshot.error && <p role="status">Loading agent runs…</p>}
          {task && snapshot.data && runs.length === 0 && (
            <p className="text-muted-foreground">No agent runs in this conversation yet.</p>
          )}
          {runs.map(run => (
            <dl key={run.id} className="space-y-2 rounded-md border p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{run.status}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Run</dt>
                <dd className="mt-1 font-mono break-all">{run.id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Submitted</dt>
                <dd className="mt-1">{new Date(run.submittedAt).toLocaleString()}</dd>
              </div>
            </dl>
          ))}
          {snapshot.data?.runCoverage?.truncated && (
            <p className="text-muted-foreground text-xs">
              Showing the most recent {snapshot.data.runCoverage.returned} of {snapshot.data.runCoverage.total} agent
              runs.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
