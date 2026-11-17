interface TaskActivity {
  readonly id: string
  readonly updatedAt: string
  readonly runtime?: {
    readonly lastActivityAt?: string
    readonly latestRun?: { readonly activityAt: string } | null
  }
}

export function taskActivityAt(task: TaskActivity): string {
  const activity = task.runtime?.lastActivityAt ?? task.runtime?.latestRun?.activityAt
  return activity && Date.parse(activity) > Date.parse(task.updatedAt) ? activity : task.updatedAt
}

/** New activity moves a chat to the top without changing its group or selection. */
export function compareTaskActivity(left: TaskActivity, right: TaskActivity): number {
  return Date.parse(taskActivityAt(right)) - Date.parse(taskActivityAt(left)) || left.id.localeCompare(right.id)
}

/** Merge refreshed records by identity while retaining cursor-page order. */
export function appendUniquePage<T extends { readonly id: string }>(loaded: readonly T[], page: readonly T[]): T[] {
  const records = new Map(loaded.map(item => [item.id, item]))
  for (const item of page) records.set(item.id, item)
  return [...records.values()]
}

/** Search is intentionally local: callers pass only the pages currently loaded. */
export function searchLoaded<T>(items: readonly T[], query: string, fields: (item: T) => readonly string[]): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...items]
  return items.filter(item => fields(item).some(field => field.toLocaleLowerCase().includes(needle)))
}
