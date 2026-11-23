import type { TaskId, TaskStatus } from '@/shared/schemas/workspace.js'
import type { WorkspaceTaskRuntimeSummary } from '@/shared/schemas/workspace-store.js'

export type TaskSectionId = 'attention' | 'working' | TaskStatus

type TaskSignal = {
  readonly section: 'attention' | 'working'
  readonly label: string
  readonly tone: 'amber' | 'indigo' | 'blue'
}

type TaskPresentation = TaskSignal | { readonly section: TaskStatus; readonly label: null; readonly tone: null }

function attention(label: string, tone: 'amber' | 'indigo' = 'amber'): TaskSignal {
  return { section: 'attention', label, tone }
}

function working(label: string): TaskSignal {
  return { section: 'working', label, tone: 'blue' }
}

function ownTaskSignal(runtime: WorkspaceTaskRuntimeSummary): TaskSignal | null {
  if (runtime.pendingRequestKind === 'approval') return attention('Approval needed')
  if (runtime.pendingRequestKind === 'question') return attention('Answer needed', 'indigo')
  switch (runtime.runStatus) {
    case 'uncertain':
      return attention('Delivery is uncertain')
    case 'recoveryRequired':
      return attention('Recovery needed')
    case 'queued':
      return working('Queued')
    case 'starting':
      return working('Starting')
    case 'running':
      return working('Running')
    case 'awaitingInput':
      return attention('Waiting for input', 'indigo')
    case 'interruptRequested':
      return working('Stopping')
    default:
      return null
  }
}

export function sidebarTaskPresentation(task: {
  readonly status: TaskStatus
  readonly runtime: WorkspaceTaskRuntimeSummary
}): TaskPresentation {
  const { status, runtime } = task
  const lifecycle = { section: status, label: null, tone: null }
  if (status === 'archived') return lifecycle
  const children = runtime.delegatedChildren
  if ((children?.approvals ?? 0) > 0) return attention('Pending approval')
  if ((children?.questions ?? 0) > 0) return attention('Awaiting input', 'indigo')
  if ((children?.attention ?? 0) > 0) return attention('Delegate needs attention')
  return ownTaskSignal(runtime) ?? ((children?.active ?? 0) > 0 ? working('Working') : lifecycle)
}

export function resolveSidebarTaskSelection(
  selectedTaskId: TaskId | null,
  parentTaskId: TaskId | undefined,
  listedTasks: readonly { readonly id: TaskId; readonly status: TaskStatus }[],
): TaskId | null {
  if (parentTaskId && listedTasks.some(task => task.id === parentTaskId && task.status !== 'archived'))
    return parentTaskId
  return selectedTaskId
}
