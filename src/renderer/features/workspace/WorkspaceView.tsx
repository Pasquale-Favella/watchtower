import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { ConversationId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceTask } from './hooks.js'
import {
  mergeWorkspaceNavigation,
  readWorkspaceNavigation,
  type WorkspaceNavigationState,
  writeWorkspaceNavigation,
} from './workspace-navigation.js'
import { WorkspaceConversation } from './WorkspaceConversation.js'
import { WorkspaceProjects } from './WorkspaceProjects.js'

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function WorkspaceView() {
  const [navigation, setNavigation] = useState<WorkspaceNavigationState>(() =>
    readWorkspaceNavigation(browserStorage()),
  )
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  useEffect(() => writeWorkspaceNavigation(browserStorage(), navigation), [navigation])

  function updateNavigation(update: Partial<WorkspaceNavigationState>) {
    setNavigation(current => mergeWorkspaceNavigation(current, update))
  }

  const selectProject = useCallback((projectId: WorkspaceNavigationState['projectId']) => {
    setNavigation(current => mergeWorkspaceNavigation(current, { projectId, taskId: null, conversationId: null }))
  }, [])
  const selectTask = useCallback((taskId: WorkspaceNavigationState['taskId']) => {
    setNavigation(current => mergeWorkspaceNavigation(current, { taskId, conversationId: null }))
  }, [])
  const selectConversation = useCallback((conversationId: ConversationId | null) => {
    setNavigation(current => mergeWorkspaceNavigation(current, { conversationId }))
  }, [])

  return (
    <main className="relative flex min-h-0 flex-1 overflow-hidden" aria-label="Agent workspace">
      <aside
        aria-label="Workspace navigation"
        className={`${mobileNavigationOpen ? 'absolute inset-y-0 left-0 z-20 flex w-[min(88vw,340px)] shadow-xl' : 'hidden'} ${navigation.navigationCollapsed ? 'md:w-14' : 'md:flex md:w-[320px]'} bg-background min-h-0 shrink-0 flex-col border-r p-3 md:relative md:flex`}
      >
        <div className="mb-2 flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="hidden md:inline-flex"
            aria-label={
              navigation.navigationCollapsed ? 'Expand workspace navigation' : 'Collapse workspace navigation'
            }
            title={navigation.navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => updateNavigation({ navigationCollapsed: !navigation.navigationCollapsed })}
          >
            {navigation.navigationCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => setMobileNavigationOpen(false)}
          >
            Close navigation
          </Button>
        </div>
        {(!navigation.navigationCollapsed || mobileNavigationOpen) && (
          <WorkspaceProjects
            selectedProjectId={navigation.projectId}
            selectedTaskId={navigation.taskId}
            onSelectProject={selectProject}
            onSelectTask={selectTask}
          />
        )}
      </aside>

      {mobileNavigationOpen && (
        <button
          aria-label="Close workspace navigation"
          className="absolute inset-0 z-10 bg-black/30 md:hidden"
          onClick={() => setMobileNavigationOpen(false)}
        />
      )}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Selected task">
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2 md:hidden">
          <Button type="button" variant="outline" size="sm" onClick={() => setMobileNavigationOpen(true)}>
            Projects and tasks
          </Button>
          <span className="text-muted-foreground truncate text-xs">
            {navigation.taskId ? 'Selected Task' : 'Workspace'}
          </span>
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
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <h1 className="text-lg font-semibold">Choose a Task</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                Select a Task from the navigator or create one in a Project.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4 md:hidden"
                onClick={() => setMobileNavigationOpen(true)}
              >
                Browse Projects
              </Button>
            </div>
          </div>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
      </header>
      <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full">
        {conversation ? (
          <WorkspaceConversation conversationId={conversation.id} />
        ) : (
          <div className="p-5 text-sm">No conversation activity yet.</div>
        )}
      </div>
    </div>
  )
}
