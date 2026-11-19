import type { WorkspaceTaskRuntimeSummary } from '@/shared/schemas/workspace-store.js'

interface TaskWithRuntime {
  readonly runtime?: WorkspaceTaskRuntimeSummary | undefined
}

/** A child Task is shown under its parent, never as a top-level row. */
export function isDelegatedChild(task: TaskWithRuntime): boolean {
  return task.runtime?.delegatedFrom != null
}

export function delegatedChildTotal(task: TaskWithRuntime): number {
  return task.runtime?.delegatedChildren?.total ?? 0
}

/** A parent whose delegates wait for an answer or approval belongs in Needs attention. */
export function hasDelegateAttention(task: TaskWithRuntime): boolean {
  return (task.runtime?.delegatedChildren?.attention ?? 0) > 0
}

/** The parent row's signal when its own Run has none: a waiting delegate first, then running delegates. */
export function delegateSignalLabel(task: TaskWithRuntime): string | null {
  const delegates = task.runtime?.delegatedChildren
  if (!delegates) return null
  if (delegates.attention > 0) return 'Delegate needs attention'
  if (delegates.active > 0) return `${delegates.active} ${delegates.active === 1 ? 'delegate' : 'delegates'} running`
  return null
}
