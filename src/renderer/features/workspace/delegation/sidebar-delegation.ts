import type { MascotMood } from '@/renderer/components/mascot/WatchtowerMascot.js'
import type { TaskId, TaskStatus } from '@/shared/schemas/workspace.js'
import type { WorkspaceTaskRuntimeSummary } from '@/shared/schemas/workspace-store.js'

export type TaskSectionId = 'attention' | 'working' | TaskStatus

/** The mascot moods a sidebar row can act out; quiet lifecycle rows keep a plain status dot instead. */
export type SidebarTaskMood = Extract<
  MascotMood,
  'queued' | 'starting' | 'working' | 'stopping' | 'approval' | 'question' | 'alert' | 'delegating'
>

type TaskSignal = {
  readonly section: 'attention' | 'working'
  readonly label: string
  readonly tone: 'amber' | 'indigo' | 'blue'
  readonly mood: SidebarTaskMood
}

type TaskPresentation =
  TaskSignal | { readonly section: TaskStatus; readonly label: null; readonly tone: null; readonly mood: null }

function attention(label: string, mood: 'approval' | 'question' | 'alert'): TaskSignal {
  return { section: 'attention', label, tone: mood === 'question' ? 'indigo' : 'amber', mood }
}

function working(label: string, mood: 'queued' | 'starting' | 'working' | 'stopping' | 'delegating'): TaskSignal {
  return { section: 'working', label, tone: 'blue', mood }
}

function ownTaskSignal(runtime: WorkspaceTaskRuntimeSummary): TaskSignal | null {
  if (runtime.pendingRequestKind === 'approval') return attention('Approval needed', 'approval')
  if (runtime.pendingRequestKind === 'question') return attention('Answer needed', 'question')
  switch (runtime.runStatus) {
    case 'uncertain':
      return attention('Delivery is uncertain', 'alert')
    case 'recoveryRequired':
      return attention('Recovery needed', 'alert')
    case 'queued':
      return working('Queued', 'queued')
    case 'starting':
      return working('Starting', 'starting')
    case 'running':
      return working('Running', 'working')
    case 'awaitingInput':
      return attention('Waiting for input', 'question')
    case 'interruptRequested':
      return working('Stopping', 'stopping')
    default:
      return null
  }
}

export function sidebarTaskPresentation(task: {
  readonly status: TaskStatus
  readonly runtime: WorkspaceTaskRuntimeSummary
}): TaskPresentation {
  const { status, runtime } = task
  const lifecycle = { section: status, label: null, tone: null, mood: null }
  if (status === 'archived') return lifecycle
  const children = runtime.delegatedChildren
  if ((children?.approvals ?? 0) > 0) return attention('Pending approval', 'approval')
  if ((children?.questions ?? 0) > 0) return attention('Awaiting input', 'question')
  if ((children?.attention ?? 0) > 0) return attention('Delegate needs attention', 'alert')
  return ownTaskSignal(runtime) ?? ((children?.active ?? 0) > 0 ? working('Working', 'delegating') : lifecycle)
}

/** The mascot mood for a sidebar row, or null when the row is quiet and shows its lifecycle dot. */
export function sidebarTaskMood(task: {
  readonly status: TaskStatus
  readonly runtime: WorkspaceTaskRuntimeSummary
}): SidebarTaskMood | null {
  return sidebarTaskPresentation(task).mood
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
