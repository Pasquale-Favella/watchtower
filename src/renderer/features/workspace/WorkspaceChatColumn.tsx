import { useEffect, useMemo, useRef, useState } from 'react'

import { LoadingRegion, SkeletonLines } from '@/renderer/components/skeletons'
import { Button } from '@/renderer/components/ui/button'
import { Popover } from '@/renderer/components/ui/popover'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { type DraftTerminalTarget, terminalOwnerKey, type TerminalTarget } from '@/shared/schemas/terminal.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { currentConversationRuns, isRunActive } from './composer-state.js'
import { useParentTaskLink } from './delegation/chat-delegation-hooks.js'
import { useDelegations } from './delegation/hooks.js'
import { isDiffAvailable } from './diff-availability.js'
import {
  useWorkspaceNativeAgentSessions,
  useWorkspaceProject,
  useWorkspaceTask,
  useWorkspaceTaskSnapshot,
} from './hooks.js'
import { usePromptAttachments } from './prompt-context-hooks.js'
import { attachmentPromptToken } from './prompt-editor.js'
import { surfaceKind, surfaceResource } from './right-panel/right-panel-state.js'
import { type RightPanelControls, useRightPanel } from './right-panel/use-right-panel.js'
import { useSideChatTabs } from './side-chat/hooks.js'
import { queueTerminalCommand } from './terminal/terminal-command-queue.js'
import { useRetainedTaskTerminalTarget } from './terminal/use-terminal-adoption.js'
import { useTerminalDrawer } from './terminal/use-terminal-drawer.js'
import { WorkspaceTerminalDrawer } from './terminal/WorkspaceTerminalDrawer.js'
import { CONVERSATION_DETAILS_LANE_INSET, useConversationDetailsLayout } from './use-conversation-details-layout.js'
import { useConversationDetailsVisibility } from './use-conversation-details-visibility.js'
import { useDraftAppend, useDraftReference, useWorkspaceCheckoutPreference } from './use-workspace-draft.js'
import { useTaskPanelResourceKey } from './use-workspace-panel-context.js'
import { useWorkspacePanelResources } from './use-workspace-panel-resources.js'
import { WorkspaceChatHeader } from './WorkspaceChatHeader.js'
import { WorkspaceComposer } from './WorkspaceComposer.js'
import { WorkspaceConversation } from './WorkspaceConversation.js'
import { WorkspaceConversationDetails } from './WorkspaceConversationDetails.js'
import { WorkspacePanelHost } from './WorkspacePanelHost.js'

export function WorkspaceChatColumn({
  taskId,
  selectedConversationId,
  onSelectTask,
  onSelectConversation,
  coach,
}: {
  taskId: TaskId
  selectedConversationId: ConversationId | null
  onSelectTask?: (taskId: TaskId | null) => void
  onSelectConversation?: (conversationId: ConversationId | null) => void
  coach?:
    | {
        readonly assistantAction: (markdown: string) => React.ReactNode
      }
    | undefined
}) {
  const [afterConversationId, setAfterConversationId] = useState<string | undefined>()
  const { measureContainer, mode: detailsMode } = useConversationDetailsLayout()
  const retainedTerminalTarget = useRetainedTaskTerminalTarget(taskId)
  const terminalTarget = useMemo<TerminalTarget>(() => ({ kind: 'task', taskId }), [taskId])
  const terminal = useTerminalDrawer(terminalTarget, !coach)
  const detail = useWorkspaceTask({
    taskId,
    options: { limit: 30, ...(afterConversationId ? { afterId: afterConversationId } : {}) },
  })
  const project = useWorkspaceProject(detail.data ? { projectId: detail.data.task.projectId } : null)
  const diffAvailable = isDiffAvailable(project.data)
  const panel = useRightPanel(coach ? null : taskId, { diffAvailable })
  const ownerKey = useTaskPanelResourceKey(taskId)
  const resources = useWorkspacePanelResources(ownerKey, panel, coach ? undefined : taskId, !coach)
  const appendDraft = useDraftAppend()
  const snapshot = useWorkspaceTaskSnapshot({ taskId, runLimit: 100 })
  const sideTabs = useSideChatTabs()
  // An open side chat tab that needs an approval or an answer is announced beside the main composer.
  const waitingSideChat = panel.surfaces.find(surface => {
    if (surfaceKind(surface) !== 'side-chat') return false
    const state = sideTabs[surfaceResource(surface)]?.state
    return state === 'needsApproval' || state === 'needsInput'
  })
  const delegations = useDelegations(coach ? null : taskId)
  const nativeSessions = useWorkspaceNativeAgentSessions({ taskId, options: { limit: 50 } })
  const sessionIdsByRunId = useMemo(
    () => new Map(snapshot.data?.runs.map(run => [run.id, run.sessionId ?? null] as const) ?? []),
    [snapshot.data?.runs],
  )
  const runContextsByRunId = useMemo(
    () => new Map(snapshot.data?.runContexts?.map(context => [context.runId, context] as const) ?? []),
    [snapshot.data?.runContexts],
  )
  const conversations = detail.data?.conversations ?? []
  const conversation =
    conversations.find(item => item.id === selectedConversationId) ?? (coach ? undefined : conversations[0])
  const preferredCheckoutId = useWorkspaceCheckoutPreference(conversation?.id ?? null)
  const {
    open: detailsOpen,
    setOpen: setDetailsOpen,
    toggle: toggleDetails,
  } = useConversationDetailsVisibility(conversation?.id ?? selectedConversationId ?? taskId, detailsMode)
  const promptCommands = useMemo(
    () =>
      nativeSessions.data?.items
        .filter(session => session.conversationId === conversation?.id)
        .flatMap(session => session.capabilities?.commands?.map(command => command.name) ?? []) ?? [],
    [nativeSessions.data?.items, conversation?.id],
  )
  const parentTask = useParentTaskLink(detail.data?.task.projectId ?? null, taskId, onSelectTask)

  useEffect(() => {
    const conversations = detail.data?.conversations
    if (!conversations) return
    if (selectedConversationId && conversations.some(item => item.id === selectedConversationId)) return
    if (selectedConversationId && detail.data?.nextAfterConversationId) {
      setAfterConversationId(detail.data.nextAfterConversationId)
      return
    }
    if (!selectedConversationId && afterConversationId) return
    onSelectConversation?.(conversations[0]?.id ?? null)
  }, [afterConversationId, detail.data, onSelectConversation, selectedConversationId])

  const header = !coach && (
    <WorkspaceChatHeader
      project={project.data?.project.name ?? 'Loading project…'}
      title={detail.data?.task.title ?? 'Loading chat…'}
      parentTask={parentTask}
      terminalOpen={terminal.open}
      onToggleTerminal={detail.data ? terminal.toggle : undefined}
      panelOpen={panel.open}
      onTogglePanel={detail.data ? panel.toggle : undefined}
      detailsOpen={detailsOpen}
      detailsMode={detailsMode}
      onToggleDetails={detail.data ? toggleDetails : undefined}
      relatedDelegationCount={
        delegations.items.filter(item => !conversation || item.parentConversationId === conversation.id).length
      }
    />
  )

  if (detail.error) {
    return (
      <Popover open={!coach && detailsOpen && detailsMode === 'popover'} onOpenChange={setDetailsOpen}>
        {header}
        <div className="m-4 space-y-2" role="alert">
          <p>
            {coach ? 'Could not load this chat.' : 'Could not load this Task. Choose another Task from the navigator.'}
          </p>
          {!coach && (
            <Button type="button" variant="outline" onClick={() => onSelectTask?.(null)}>
              Back to Tasks
            </Button>
          )}
        </div>
      </Popover>
    )
  }
  if (!detail.data)
    return (
      <Popover open={!coach && detailsOpen && detailsMode === 'popover'} onOpenChange={setDetailsOpen}>
        {header}
        <div className="p-4">
          <LoadingRegion label="Loading Task…" className="max-w-chat mx-auto flex flex-col gap-4">
            <Skeleton className="h-4 w-2/5" />
            <SkeletonLines lines={4} />
          </LoadingRegion>
        </div>
      </Popover>
    )

  const nextConversationId = detail.data.nextAfterConversationId
  const task = detail.data.task
  const hasSeveral = detail.data.totalConversations > 1
  const latestRun = conversation
    ? currentConversationRuns(snapshot.data?.runs ?? [], snapshot.data?.runContexts ?? [], conversation.id).sort(
        (left, right) => right.submittedAt.localeCompare(left.submittedAt),
      )[0]
    : undefined
  const runContext = snapshot.data?.runContexts?.find(context => context.runId === latestRun?.id)
  const availableCheckouts = project.data ? [project.data.mainCheckout, ...project.data.otherCheckouts] : []
  const checkout =
    availableCheckouts.find(item => item.id === (runContext?.checkoutId ?? preferredCheckoutId)) ??
    (!runContext ? project.data?.mainCheckout : undefined)
  const checkoutId = runContext?.checkoutId ?? checkout?.id
  // A side chat's bring-back waits for this Conversation to be idle, so the side pane reads it from here.
  const parentBusy = conversation
    ? currentConversationRuns(snapshot.data?.runs ?? [], snapshot.data?.runContexts ?? [], conversation.id).some(
        isRunActive,
      )
    : false
  const addToChat = conversation
    ? (excerpt: {
        readonly label: string
        readonly lineStart: number
        readonly lineEnd: number
        readonly text: string
      }) => {
        appendDraft(
          conversation.id,
          `${excerpt.label}, lines ${excerpt.lineStart}-${excerpt.lineEnd}:\n${excerpt.text}`,
        )
      }
    : undefined

  return (
    <Popover open={!coach && detailsOpen && detailsMode === 'popover'} onOpenChange={setDetailsOpen}>
      {header}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={measureContainer}
          className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${!coach && panel.maximized ? 'min-[980px]:hidden' : ''}`}
        >
          <div
            role="region"
            aria-label="Main conversation"
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            style={
              !coach && detailsOpen && detailsMode === 'inline'
                ? { paddingRight: CONVERSATION_DETAILS_LANE_INSET }
                : undefined
            }
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>section]:h-full">
              {conversation ? (
                <WorkspaceConversation
                  conversationId={conversation.id}
                  sessionIdsByRunId={sessionIdsByRunId}
                  runContextsByRunId={runContextsByRunId}
                  promptCommands={promptCommands}
                  workspacePath={runContext?.workspacePath ?? checkout?.path}
                  onOpenFile={coach ? undefined : panel.openFile}
                  coach={coach}
                  onOpenParentTask={onSelectTask}
                  scope={{ projectId: task.projectId, ...(checkoutId ? { checkoutId } : {}) }}
                />
              ) : (
                <div className="p-5 text-sm">No conversation activity yet.</div>
              )}
            </div>
            {conversation && task.status !== 'archived' && (
              <div key={conversation.id} className="shrink-0">
                {waitingSideChat && (
                  <div role="status" className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs">
                    <span>Side chat waiting</span>
                    <Button type="button" variant="outline" size="xs" onClick={() => panel.activate(waitingSideChat)}>
                      Open
                    </Button>
                  </div>
                )}
                <WorkspaceComposer
                  onOpenFile={coach ? undefined : panel.openFile}
                  task={task}
                  conversationId={conversation.id}
                  onSideChatCreated={coach ? undefined : id => panel.addSurface('side-chat', id)}
                  coach={coach !== undefined}
                />
              </div>
            )}
            {task.status === 'archived' && (
              <p className="text-muted-foreground border-t px-4 py-3 text-sm">
                This chat is archived. Restore it to send a message.
              </p>
            )}
            {!coach && (
              <WorkspaceTerminalDrawer
                target={terminalTarget}
                open={terminal.open}
                onOpenLink={url => resources.openBrowser(url)}
                onAddToChat={addToChat}
              />
            )}
            {!coach && (
              <WorkspaceConversationDetails
                open={detailsOpen}
                onOpenChange={setDetailsOpen}
                mode={detailsMode}
                taskId={task.id}
                conversationId={conversation?.id ?? null}
                projectId={task.projectId}
                checkoutId={checkoutId}
                workspacePath={runContext?.workspacePath ?? checkout?.path}
                isScratch={project.data?.project.isScratch}
                onOpenFiles={() => panel.openSurface('files')}
                onOpenDiff={diffAvailable ? () => panel.openSurface('diff') : undefined}
                onOpenPullRequests={() => panel.openSurface('pull-requests')}
                onOpenSideChat={id => panel.addSurface('side-chat', id)}
              >
                {hasSeveral || nextConversationId ? (
                  <div className="space-y-2">
                    {hasSeveral && (
                      <label className="flex min-w-0 flex-col gap-2 text-xs">
                        Conversation
                        <select
                          className="bg-background w-full min-w-0 rounded-md border px-2 py-1"
                          value={conversation?.id ?? ''}
                          onChange={event => onSelectConversation?.(event.target.value as ConversationId)}
                        >
                          {conversations.map((item, index) => (
                            <option key={item.id} value={item.id}>
                              {item.title ?? `Conversation ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {nextConversationId && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onSelectConversation?.(null)
                          setAfterConversationId(nextConversationId)
                        }}
                      >
                        More conversations
                      </Button>
                    )}
                  </div>
                ) : null}
              </WorkspaceConversationDetails>
            )}
          </div>
        </div>
        {!coach && (
          <TaskRightPanel
            projectId={task.projectId}
            conversationId={conversation?.id ?? null}
            taskStatus={task.status}
            checkoutId={checkoutId}
            diffAvailable={diffAvailable}
            panel={panel}
            resources={resources}
            ownerKey={ownerKey}
            terminalTarget={terminalTarget}
            retainedTerminalTarget={retainedTerminalTarget}
            onToggleTerminal={terminal.toggle}
            onAddToChat={addToChat}
            parent={
              conversation && snapshot.data?.runContexts?.some(context => context.conversationId === conversation.id)
                ? { taskId, conversationId: conversation.id }
                : undefined
            }
            parentTitle={task.title}
            parentBusy={parentBusy}
            onRunShellCommand={command => {
              if (panel.maximized) panel.toggleMaximized()
              queueTerminalCommand(terminalOwnerKey(terminalTarget), command)
              if (!terminal.open) terminal.setOpen(true)
            }}
          />
        )}
      </div>
    </Popover>
  )
}

/** Refreshes after each Task status change, so finished Runs show their changes without a manual reload. */
function TaskRightPanel({
  projectId,
  conversationId,
  taskStatus,
  ...panel
}: {
  readonly projectId: ProjectId
  readonly conversationId: ConversationId | null
  readonly taskStatus: string
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly diffAvailable?: boolean | undefined
  readonly panel: RightPanelControls
  readonly resources: ReturnType<typeof useWorkspacePanelResources>
  readonly ownerKey: string
  readonly terminalTarget: TerminalTarget
  readonly retainedTerminalTarget?: DraftTerminalTarget | undefined
  readonly onToggleTerminal: () => void
  readonly onAddToChat?: React.ComponentProps<typeof WorkspacePanelHost>['onAddToChat']
  readonly parent?: React.ComponentProps<typeof WorkspacePanelHost>['parent']
  readonly parentTitle?: string | undefined
  readonly parentBusy?: boolean | undefined
  readonly onRunShellCommand?: ((command: string) => void) | undefined
}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const referenceInDraft = useDraftReference()
  const appendDraft = useDraftAppend()
  const attachments = usePromptAttachments(conversationId ?? 'new-chat')
  const lastStatus = useRef(taskStatus)
  useEffect(() => {
    if (lastStatus.current === taskStatus) return
    lastStatus.current = taskStatus
    setRefreshKey(key => key + 1)
  }, [taskStatus])
  return (
    <WorkspacePanelHost
      {...panel}
      projectId={projectId}
      refreshKey={refreshKey}
      reviewOwnerKey={conversationId ?? panel.ownerKey}
      onReferencePath={path => conversationId && referenceInDraft(conversationId, path)}
      onReferenceText={text => conversationId && appendDraft(conversationId, text)}
      onAddImage={
        conversationId
          ? async image => {
              const item = await attachments.importFile({
                name: 'workspace-screenshot.png',
                mediaType: 'image/png',
                data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
                ...(image.annotation ? { annotation: image.annotation } : {}),
              })
              attachments.add(item)
              appendDraft(
                conversationId,
                image.annotation ? attachmentPromptToken(item) : `${image.text}\n\n${attachmentPromptToken(item)}`,
              )
            }
          : undefined
      }
    />
  )
}
