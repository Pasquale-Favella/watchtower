import { MessagesSquare, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { LoadingRegion, SkeletonLines } from '@/renderer/components/skeletons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import type { SideChatBinding } from '@/shared/schemas/workspace-side-chats.js'

import { isRunActive } from '../composer-state.js'
import { useErrorToast } from '../error-toast.js'
import {
  useWorkspaceNativeAgentSessions,
  useWorkspacePendingRequests,
  useWorkspaceTask,
  useWorkspaceTaskSnapshot,
} from '../hooks.js'
import { firstPendingRequest } from '../request-drawer-state.js'
import { TimelineRoutesContext } from '../timeline/timeline-routes.js'
import { WorkspaceComposer } from '../WorkspaceComposer.js'
import { WorkspaceConversation } from '../WorkspaceConversation.js'
import {
  useBringBackSideChat,
  useDeleteSideChat,
  usePublishSideChatTab,
  useSideChatBinding,
  useSideChatPreferences,
  useSideChatTitleRefresh,
} from './hooks.js'
import { WorkspaceQueryScopeContext } from './scope-context.js'
import { sideChatTabState } from './status.js'
import { useSideChatQueryScope } from './use-side-chat-query-scope.js'

export interface SideChatPaneProps {
  readonly id: string
  readonly visible?: boolean | undefined
  readonly parentTitle: string
  /** The main chat has an active or queued Run, so a bring-back must wait. Read from the parent view's snapshot. */
  readonly parentBusy?: boolean | undefined
  readonly onClose: () => void
  readonly onDeleted: () => void
  /** File references open in the main chat's file panel, since a side chat shares its checkout. */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** Tool diffs open the main chat's diff panel, since a side chat shares its checkout. */
  readonly onOpenDiff?: (() => void) | undefined
  /** Command rows run in the main chat's terminal drawer. */
  readonly onRunShellCommand?: ((command: string) => void) | undefined
}
export function SideChatPane(props: SideChatPaneProps): React.JSX.Element {
  const binding = useSideChatBinding(props.id)
  const scope = useSideChatQueryScope()
  if (binding.deleted)
    return (
      <p role="status" className="text-muted-foreground p-4 text-sm">
        This side chat was deleted.
      </p>
    )
  if (binding.error)
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        {binding.error}
      </p>
    )
  if (!binding.data)
    return (
      <LoadingRegion label="Loading side chat..." className="flex flex-col gap-3 p-4">
        <Skeleton className="ml-auto h-9 w-3/5 rounded-lg" />
        <SkeletonLines lines={4} />
      </LoadingRegion>
    )
  return (
    <WorkspaceQueryScopeContext value={scope}>
      <SideChatContent {...props} binding={binding.data} />
    </WorkspaceQueryScopeContext>
  )
}
function SideChatContent({
  binding,
  onClose,
  onDeleted,
  visible = true,
  onOpenFile,
  onOpenDiff,
  onRunShellCommand,
  parentTitle,
  parentBusy = false,
}: SideChatPaneProps & { readonly binding: SideChatBinding }): React.JSX.Element {
  const detail = useWorkspaceTask({ taskId: binding.taskId, options: { limit: 30 } })
  const snapshot = useWorkspaceTaskSnapshot({ taskId: binding.taskId, runLimit: 100 })
  const nativeSessions = useWorkspaceNativeAgentSessions({ taskId: binding.taskId, options: { limit: 50 } })
  const sessionIdsByRunId = useMemo(
    () => new Map(snapshot.data?.runs.map(run => [run.id, run.sessionId ?? null] as const) ?? []),
    [snapshot.data?.runs],
  )
  const runContextsByRunId = useMemo(
    () => new Map(snapshot.data?.runContexts?.map(context => [context.runId, context] as const) ?? []),
    [snapshot.data?.runContexts],
  )
  const sideBusy = snapshot.data?.runs.some(isRunActive) ?? false
  const completed = snapshot.data?.runs.some(run => run.status === 'completed') ?? false
  const back = useBringBackSideChat(binding.id)
  const remove = useDeleteSideChat()
  useErrorToast(`workspace:side-chat:${binding.id}:bring-back`, "Couldn't bring back side chat", back.error)
  useErrorToast(`workspace:side-chat:${binding.id}:delete`, "Couldn't delete side chat", remove.error)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const runContext = snapshot.data?.runContexts?.find(context => context.conversationId === binding.conversationId)
  const promptCommands = useMemo(
    () =>
      nativeSessions.data?.items
        .filter(session => session.conversationId === binding.conversationId)
        .flatMap(session => session.capabilities?.commands?.map(command => command.name) ?? []) ?? [],
    [nativeSessions.data?.items, binding.conversationId],
  )
  const bringBackReason = parentBusy
    ? 'Available when the main chat is idle.'
    : !completed || sideBusy
      ? 'Available after a finished reply.'
      : null
  const title = detail.data?.task.title ?? binding.title
  const pendingQuery = useMemo(() => firstPendingRequest(binding.taskId), [binding.taskId])
  const pending = useWorkspacePendingRequests(pendingQuery)
  const pendingRequestKind = (pending.data?.items ?? []).some(item => item.request.kind === 'approval')
    ? 'approval'
    : (pending.data?.items ?? []).some(item => item.request.kind === 'question')
      ? 'question'
      : null
  const tabState = sideChatTabState({ runs: snapshot.data?.runs ?? [], pendingRequestKind })
  // The pane publishes its tab title and state, so the tab strip and the main chat read them without a query of their own.
  usePublishSideChatTab(binding.id, title, tabState)
  useSideChatTitleRefresh(binding.parentTaskId, title)
  useSideChatPreferences(binding.parentConversationId, binding.conversationId, binding.checkoutId)
  return (
    <section
      aria-label="Side chat"
      data-side-chat-pane={binding.taskId}
      aria-hidden={!visible}
      inert={!visible}
      style={!visible ? { display: 'none' } : undefined}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-disabled={bringBackReason !== null}
          disabled={back.pending}
          onClick={() => {
            if (bringBackReason === null) void back.bringBack()
          }}
          title={bringBackReason ?? "Adds this side chat to the main chat's next message."}
        >
          Bring back
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete side chat"
          disabled={remove.pending || sideBusy}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close side chat" onClick={onClose}>
          <X />
        </Button>
      </header>
      {back.receipt && !back.error && (
        <p role="status" className="text-muted-foreground shrink-0 px-3 py-1.5 text-xs">
          Brought back. The main chat gets this side chat with your next message.
        </p>
      )}
      {detail.error && (
        <p role="alert" className="text-destructive p-3 text-sm">
          {detail.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full">
        <TimelineRoutesContext value={{ openDiff: onOpenDiff, runShellCommand: onRunShellCommand }}>
          <WorkspaceConversation
            conversationId={binding.conversationId}
            sessionIdsByRunId={sessionIdsByRunId}
            runContextsByRunId={runContextsByRunId}
            promptCommands={promptCommands}
            workspacePath={runContext?.workspacePath}
            onOpenFile={onOpenFile}
            scope={detail.data ? { projectId: detail.data.task.projectId, checkoutId: binding.checkoutId } : undefined}
            leading={
              <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-[11px]">
                <span className="bg-border h-px flex-1" />
                <MessagesSquare aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">Context from {parentTitle || 'the main chat'}</span>
                <span className="bg-border h-px flex-1" />
              </div>
            }
          />
        </TimelineRoutesContext>
      </div>
      {detail.data && (
        <WorkspaceComposer
          embedded
          onOpenFile={onOpenFile}
          key={binding.conversationId}
          task={detail.data.task}
          conversationId={binding.conversationId}
        />
      )}
      <AlertDialog open={confirmingDelete} onOpenChange={open => setConfirmingDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete side chat &quot;{title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes the side chat and its history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false)
                void remove.remove({ id: binding.id, parentTaskId: binding.parentTaskId }).then(deleted => {
                  if (deleted) onDeleted()
                })
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
