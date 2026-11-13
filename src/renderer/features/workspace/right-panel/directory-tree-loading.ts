export interface ExpandedDirectoryState {
  readonly paths: ReadonlySet<string>
  readonly newlyExpanded: readonly string[]
}

export function reconcileExpandedDirectories(
  directoryPaths: readonly string[],
  previousPaths: ReadonlySet<string>,
  isExpanded: (path: string) => boolean,
): ExpandedDirectoryState {
  const paths = new Set<string>()
  const newlyExpanded: string[] = []
  for (const path of directoryPaths) {
    if (!path.endsWith('/')) continue
    if (!isExpanded(path)) continue
    paths.add(path)
    if (!previousPaths.has(path)) newlyExpanded.push(path)
  }
  return { paths, newlyExpanded }
}
