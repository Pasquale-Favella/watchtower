import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { DraftTerminalTarget, TerminalTarget } from '@/shared/schemas/terminal.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import {
  useWorkspaceNativeAgentSessions,
  useWorkspaceProject,
  useWorkspaceTask,
  useWorkspaceTaskSnapshot,
} from './hooks.js'
import { usePromptAttachments } from './prompt-context-hooks.js'
import { type RightPanelControls, useRightPanel } from './right-panel/use-right-panel.js'
import { useRetainedTaskTerminalTarget } from './terminal/use-terminal-adoption.js'
import { useTerminalDrawer } from './terminal/use-terminal-drawer.js'
import { WorkspaceTerminalDrawer } from './terminal/WorkspaceTerminalDrawer.js'
import { useDraftAppend, useDraftReference } from './use-workspace-draft.js'
import { useWorkspaceNavigation } from './use-workspace-navigation.js'
import { useTaskPanelResourceKey } from './use-workspace-panel-context.js'
import { useWorkspacePanelResources } from './use-workspace-panel-resources.js'
import { WorkspaceChatHeader } from './WorkspaceChatHeader.js'
import { WorkspaceComposer } from './WorkspaceComposer.js'
import { WorkspaceConversation } from './WorkspaceConversation.js'
import { WorkspaceNewChat } from './WorkspaceNewChat.js'
import { WorkspacePanelHost } from './WorkspacePanelHost.js'
import { WorkspaceProjectDialog } from './WorkspaceProjectDialog.js'
import { WorkspaceRunDetails } from './WorkspaceRunDetails.js'

export function WorkspaceView() {
  const { navigation, selectProject, selectTask, selectConversation } = useWorkspaceNavigation()

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agent workspace">
      <WorkspaceProjectDialog />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Selected task">
        {navigation.taskId ? (
          <TaskConversation
            key={navigation.taskId}
            taskId={navigation.taskId}
            selectedConversationId={navigation.conversationId}
            onSelectTask={selectTask}
            onSelectConversation={selectConversation}
          />
        ) : (
          <WorkspaceNewChat
            projectId={navigation.projectId}
            onProjectChange={selectProject}
            onStarted={(projectId, taskId, conversationId) => {
              selectProject(projectId)
              selectTask(taskId)
              selectConversation(conversationId)
            }}
          />
        )}
      </section>
    </main>
  )
}

function TaskConversation({
  taskId,
  selectedConversationId,
  onSelectTask,
  onSelectConversation,
}: {
  taskId: TaskId
  selectedConversationId: ConversationId | null
  onSelectTask: (taskId: TaskId | null) => void
  onSelectConversation: (conversationId: ConversationId | null) => void
}) {
  const [afterConversationId, setAfterConversationId] = useState<string | undefined>()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const retainedTerminalTarget = useRetainedTaskTerminalTarget(taskId)
  const terminalTarget = useMemo<TerminalTarget>(() => ({ kind: 'task', taskId }), [taskId])
  const terminal = useTerminalDrawer(terminalTarget)
  const panel = useRightPanel(taskId)
  const ownerKey = useTaskPanelResourceKey(taskId)
  const resources = useWorkspacePanelResources(ownerKey, panel)
  const appendDraft = useDraftAppend()
  const snapshot = useWorkspaceTaskSnapshot({ taskId, runLimit: 100 })
  const nativeSessions = useWorkspaceNativeAgentSessions({ taskId, options: { limit: 50 } })
  const sessionIdsByRunId = useMemo(
    () => new Map(snapshot.data?.runs.map(run => [run.id, run.sessionId ?? null] as const) ?? []),
    [snapshot.data?.runs],
  )
  const detail = useWorkspaceTask({
    taskId,
    options: { limit: 30, ...(afterConversationId ? { afterId: afterConversationId } : {}) },
  })
  const conversations = detail.data?.conversations ?? []
  const conversation = conversations.find(item => item.id === selectedConversationId) ?? conversations[0]
  const promptCommands = useMemo(
    () =>
      nativeSessions.data?.items
        .filter(session => session.conversationId === conversation?.id)
        .flatMap(session => session.capabilities?.commands?.map(command => command.name) ?? []) ?? [],
    [nativeSessions.data?.items, conversation?.id],
  )
  const project = useWorkspaceProject(detail.data ? { projectId: detail.data.task.projectId } : null)

  useEffect(() => {
    const conversations = detail.data?.conversations
    if (!conversations) return
    if (selectedConversationId && conversations.some(item => item.id === selectedConversationId)) return
    if (selectedConversationId && detail.data?.nextAfterConversationId) {
      setAfterConversationId(detail.data.nextAfterConversationId)
      return
    }
    if (!selectedConversationId && afterConversationId) return
    onSelectConversation(conversations[0]?.id ?? null)
  }, [afterConversationId, detail.data, onSelectConversation, selectedConversationId])

  const header = (
    <WorkspaceChatHeader
      project={project.data?.project.name ?? 'Loading project…'}
      title={detail.data?.task.title ?? 'Loading chat…'}
      terminalOpen={terminal.open}
      onToggleTerminal={detail.data ? terminal.toggle : undefined}
      panelOpen={panel.open}
      onTogglePanel={detail.data ? panel.toggle : undefined}
      detailsOpen={detailsOpen}
      onToggleDetails={() => setDetailsOpen(open => !open)}
    />
  )

  if (detail.error) {
    return (
      <>
        {header}
        <div className="m-4 space-y-2" role="alert">
          <p>Could not load this Task. Choose another Task from the navigator.</p>
          <Button type="button" variant="outline" onClick={() => onSelectTask(null)}>
            Back to Tasks
          </Button>
        </div>
      </>
    )
  }
  if (!detail.data)
    return (
      <>
        {header}
        <p role="status" className="p-4">
          Loading Task…
        </p>
      </>
    )

  const nextConversationId = detail.data.nextAfterConversationId
  const task = detail.data.task
  const hasSeveral = detail.data.totalConversations > 1
  const runContext = snapshot.data?.runContexts?.find(context => context.conversationId === conversation?.id)
  const checkoutId = runContext?.checkoutId
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
    <>
      {header}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          role="region"
          aria-label="Main conversation"
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${panel.maximized ? 'min-[980px]:hidden' : ''}`}
        >
          <WorkspaceRunDetails
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
            task={task}
            conversationId={conversation?.id ?? null}
          >
            {hasSeveral && (
              <label className="flex items-center gap-2 text-xs">
                Conversation
                <select
                  className="bg-background max-w-56 rounded-md border px-2 py-1"
                  value={conversation?.id ?? ''}
                  onChange={event => onSelectConversation(event.target.value as ConversationId)}
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
                  onSelectConversation(null)
                  setAfterConversationId(nextConversationId)
                }}
              >
                More conversations
              </Button>
            )}
          </WorkspaceRunDetails>
          <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full">
            {conversation ? (
              <WorkspaceConversation
                conversationId={conversation.id}
                sessionIdsByRunId={sessionIdsByRunId}
                promptCommands={promptCommands}
                workspacePath={runContext?.workspacePath}
                onOpenFile={panel.openFile}
                scope={{ projectId: task.projectId, ...(checkoutId ? { checkoutId } : {}) }}
              />
            ) : (
              <div className="p-5 text-sm">No conversation activity yet.</div>
            )}
          </div>
          {conversation && (
            <div key={conversation.id} className="shrink-0">
              <WorkspaceComposer
                onOpenFile={panel.openFile}
                task={task}
                conversationId={conversation.id}
                onSideChatCreated={id => panel.addSurface('side-chat', id)}
              />
            </div>
          )}
          <WorkspaceTerminalDrawer
            target={terminalTarget}
            open={terminal.open}
            onOpenLink={url => resources.openBrowser(url)}
            onAddToChat={addToChat}
          />
        </div>
        <TaskRightPanel
          projectId={task.projectId}
          conversationId={conversation?.id ?? null}
          taskStatus={task.status}
          checkoutId={checkoutId}
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
          onOpenTask={(nextTaskId, nextConversationId) => {
            onSelectTask(nextTaskId)
            onSelectConversation(nextConversationId)
          }}
        />
      </div>
    </>
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
  readonly panel: RightPanelControls
  readonly resources: ReturnType<typeof useWorkspacePanelResources>
  readonly ownerKey: string
  readonly terminalTarget: TerminalTarget
  readonly retainedTerminalTarget?: DraftTerminalTarget | undefined
  readonly onToggleTerminal: () => void
  readonly onAddToChat?: React.ComponentProps<typeof WorkspacePanelHost>['onAddToChat']
  readonly parent?: React.ComponentProps<typeof WorkspacePanelHost>['parent']
  readonly onOpenTask?: React.ComponentProps<typeof WorkspacePanelHost>['onOpenTask']
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
              })
              attachments.add(item)
              appendDraft(conversationId, image.text)
            }
          : undefined
      }
    />
  )
}
