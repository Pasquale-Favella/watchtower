import type { FileTreeBatchOperation } from '@pierre/trees'

type PathKind = 'directory' | 'file'

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

function isInsideDirectory(path: string, removedDirectories: ReadonlySet<string>): boolean {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    if (removedDirectories.has(path.slice(0, slash + 1))) return true
  }
  return false
}

/**
 * Pierre needs every directory listed explicitly, so a file added alone would make the tree infer
 * its ancestors. Search returns bare paths; listings and search then disagree about which of those
 * directories already exist and the tree rejects the second copy as a duplicate path.
 */
export function buildFileTreePaths(paths: readonly string[], root = ''): string[] {
  const prefix = root === '' ? '' : `${root}/`
  const rootDepth = root === '' ? 0 : root.split('/').length
  const kinds = new Map<string, PathKind>()
  for (const raw of paths) {
    const directory = raw.endsWith('/')
    const path = directory ? raw.slice(0, -1) : raw
    if (path === '' || path === root || !path.startsWith(prefix)) continue
    const segments = path.split('/')
    for (let index = rootDepth + 1; index < segments.length; index++)
      kinds.set(segments.slice(0, index).join('/'), 'directory')
    if (directory || kinds.get(path) !== 'directory') kinds.set(path, directory ? 'directory' : 'file')
  }
  return [...kinds].map(([path, kind]) => (kind === 'directory' ? `${path}/` : path))
}

/** Parents are added before their children and removed after them, so the model never infers a path. */
export function buildFileTreePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths)
  const next = new Set(nextPaths)
  const removedDirectories = new Set<string>()
  const updates: FileTreeBatchOperation[] = []
  for (const path of previousPaths
    .filter(path => !next.has(path))
    .sort((left, right) => pathDepth(left) - pathDepth(right))) {
    if (isInsideDirectory(path, removedDirectories)) continue
    const recursive = path.endsWith('/')
    updates.push({ type: 'remove', path, ...(recursive ? { recursive: true } : {}) })
    if (recursive) removedDirectories.add(path)
  }
  for (const path of nextPaths
    .filter(path => !previous.has(path))
    .sort((left, right) => pathDepth(left) - pathDepth(right)))
    updates.push({ type: 'add', path })
  return updates
}

/** A batch aborts on a path the model does not agree exists, so each operation is checked first. */
export function applicableFileTreeUpdates(
  updates: readonly FileTreeBatchOperation[],
  hasPath: (path: string) => boolean,
): FileTreeBatchOperation[] {
  return updates.filter(update =>
    update.type === 'add' ? !hasPath(update.path) : update.type === 'remove' ? hasPath(update.path) : true,
  )
}
