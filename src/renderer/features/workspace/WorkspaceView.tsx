import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceTask } from './hooks.js'
import { WorkspaceConversation } from './WorkspaceConversation.js'
import { WorkspaceProjects } from './WorkspaceProjects.js'

export function WorkspaceView() {
  const [taskId, setTaskId] = useState<TaskId | null>(null)
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto p-5" aria-label="Agent workspace">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Workspace</h1>
        <p className="text-muted-foreground text-sm">Projects, tasks and durable agent conversations.</p>
      </header>
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <aside className="min-w-0 overflow-auto" aria-label="Projects and tasks">
          <WorkspaceProjects onSelectTask={setTaskId} />
        </aside>
        <section className="min-w-0 overflow-auto rounded-xl border p-4" aria-label="Selected task">
          {taskId ? (
            <TaskConversation key={taskId} taskId={taskId} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Select a task to read its conversations, or register a project to begin.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

function TaskConversation({ taskId }: { taskId: TaskId }) {
  const [afterConversationId, setAfterConversationId] = useState<string | undefined>()
  const detail = useWorkspaceTask({
    taskId,
    options: { limit: 30, ...(afterConversationId ? { afterId: afterConversationId } : {}) },
  })
  const [selection, setSelection] = useState<string | null>(null)
  const conversation = detail.data?.conversations.find(item => item.id === selection) ?? detail.data?.conversations[0]
  if (detail.error) return <p role="alert">{detail.error}</p>
  if (!detail.data) return <p role="status">Loading task…</p>
  const nextConversationId = detail.data.nextAfterConversationId
  return (
    <>
      <header className="mb-4 space-y-2">
        <h2 className="text-lg font-semibold">{detail.data.task.title}</h2>
        <p className="text-muted-foreground text-sm">{detail.data.task.status}</p>
        <p className="text-sm break-words whitespace-pre-wrap">{detail.data.task.description}</p>
        {detail.data.task.payloadRef && (
          <p className="text-muted-foreground text-xs">
            Task details are summarized. Full details remain stored locally.
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Conversation
          <select
            className="bg-background rounded-md border p-2"
            value={conversation?.id ?? ''}
            onChange={event => setSelection(event.target.value)}
          >
            {detail.data.conversations.map((item, index) => (
              <option key={item.id} value={item.id}>
                {item.title ?? `Conversation ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          {afterConversationId && (
            <Button
              variant="outline"
              onClick={() => {
                setSelection(null)
                setAfterConversationId(undefined)
              }}
            >
              First conversations
            </Button>
          )}
          {nextConversationId && (
            <Button
              variant="outline"
              onClick={() => {
                setSelection(null)
                setAfterConversationId(nextConversationId)
              }}
            >
              Next conversations
            </Button>
          )}
        </div>
      </header>
      {conversation ? <WorkspaceConversation conversationId={conversation.id} /> : <p>No conversations yet.</p>}
    </>
  )
}
