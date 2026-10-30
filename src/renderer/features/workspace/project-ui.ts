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
