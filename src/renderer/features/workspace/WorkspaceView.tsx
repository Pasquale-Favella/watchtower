import { PanelRight, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { SidebarTrigger } from '@/renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { ConversationId, ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceTask } from './hooks.js'
import { useRightPanel } from './right-panel/use-right-panel.js'
import { WorkspaceRightPanel } from './right-panel/WorkspaceRightPanel.js'
import { useTerminalDrawer } from './terminal/use-terminal-drawer.js'
import { WorkspaceTerminalDrawer } from './terminal/WorkspaceTerminalDrawer.js'
import { useDraftReference } from './use-workspace-draft.js'
import { useWorkspaceNavigation } from './use-workspace-navigation.js'
import { WorkspaceComposer } from './WorkspaceComposer.js'
import { WorkspaceConversation } from './WorkspaceConversation.js'
import { WorkspaceNewChat } from './WorkspaceNewChat.js'
import { WorkspaceProjectDialog } from './WorkspaceProjectDialog.js'
import { WorkspaceRequests } from './WorkspaceRequests.js'

export function WorkspaceView() {
  const { navigation, selectProject, selectTask, selectConversation } = useWorkspaceNavigation()

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agent workspace">
      <WorkspaceProjectDialog />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Selected task">
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <SidebarTrigger aria-label="Toggle workspace navigation" />
          <span className="text-muted-foreground truncate text-xs">{navigation.taskId ? 'Chat' : 'Workspace'}</span>
        </header>
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
  const terminal = useTerminalDrawer(taskId)
  const panel = useRightPanel(taskId)
  const detail = useWorkspaceTask({
    taskId,
    options: { limit: 30, ...(afterConversationId ? { afterId: afterConversationId } : {}) },
  })

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

  if (detail.error) {
    return (
      <div className="m-4 space-y-2" role="alert">
        <p>Could not load this Task. Choose another Task from the navigator.</p>
        <Button type="button" variant="outline" onClick={() => onSelectTask(null)}>
          Back to Tasks
        </Button>
      </div>
    )
  }
  if (!detail.data)
    return (
      <p role="status" className="p-4">
        Loading Task…
      </p>
    )

  const conversations = detail.data.conversations
  const conversation = conversations.find(item => item.id === selectedConversationId) ?? conversations[0]
  const nextConversationId = detail.data.nextAfterConversationId
  const task = detail.data.task
  const hasSeveral = detail.data.totalConversations > 1

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{task.title}</h1>
            <p className="text-muted-foreground text-xs">
              {task.status}
              {task.description ? ` · ${task.description}` : ''}
            </p>
            {task.payloadRef && (
              <p className="text-muted-foreground text-[10px]">
                Task details are summarized; full details remain stored locally.
              </p>
            )}
          </div>
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
          <div className="flex items-center gap-1">
            <PanelToggle label="Terminal" shortcut="Ctrl+J" pressed={terminal.open} onClick={terminal.toggle}>
              <SquareTerminal className="size-4" />
            </PanelToggle>
            <PanelToggle label="Changes and files" shortcut="Ctrl+Alt+B" pressed={panel.open} onClick={panel.toggle}>
              <PanelRight className="size-4" />
            </PanelToggle>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full">
          {conversation ? (
            <WorkspaceConversation conversationId={conversation.id} />
          ) : (
            <div className="p-5 text-sm">No conversation activity yet.</div>
          )}
        </div>
        {conversation && (
          <div key={conversation.id} className="shrink-0">
            <WorkspaceRequests taskId={task.id} conversationId={conversation.id} />
            <WorkspaceComposer task={task} conversationId={conversation.id} />
          </div>
        )}
        <WorkspaceTerminalDrawer taskId={task.id} open={terminal.open} onOpenChange={terminal.setOpen} />
      </div>
      <TaskRightPanel
        projectId={task.projectId}
        conversationId={conversation?.id ?? null}
        taskStatus={task.status}
        open={panel.open}
        onOpenChange={panel.setOpen}
        tab={panel.tab}
        onTabChange={panel.setTab}
      />
    </div>
  )
}

function PanelToggle({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  readonly label: string
  readonly shortcut: string
  readonly pressed: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            className={pressed ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>
        {label} <span className="text-muted-foreground">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
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
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly tab: ReturnType<typeof useRightPanel>['tab']
  readonly onTabChange: ReturnType<typeof useRightPanel>['setTab']
}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const referenceInDraft = useDraftReference()
  const lastStatus = useRef(taskStatus)
  useEffect(() => {
    if (lastStatus.current === taskStatus) return
    lastStatus.current = taskStatus
    setRefreshKey(key => key + 1)
  }, [taskStatus])
  return (
    <WorkspaceRightPanel
      {...panel}
      projectId={projectId}
      refreshKey={refreshKey}
      onReferencePath={path => conversationId && referenceInDraft(conversationId, path)}
    />
  )
}
