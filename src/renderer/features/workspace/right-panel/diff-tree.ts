import type { DiffFile } from '@/shared/schemas/checkout-inspection.js'

export interface DiffFolderNode {
  readonly kind: 'folder'
  readonly name: string
  /** Slash-separated folder path, unique within one source. */
  readonly path: string
  readonly children: readonly DiffTreeNode[]
  readonly additions: number
  readonly deletions: number
}

export interface DiffFileNode {
  readonly kind: 'file'
  readonly name: string
  readonly path: string
  readonly file: DiffFile
}

export type DiffTreeNode = DiffFolderNode | DiffFileNode

interface MutableFolder {
  readonly name: string
  readonly path: string
  readonly folders: Map<string, MutableFolder>
  readonly files: DiffFileNode[]
  additions: number
  deletions: number
}

/** Stable identity for selection across refreshes: a rename keeps its source path in the key. */
export function diffFileKey(file: Pick<DiffFile, 'path' | 'previousPath'>): string {
  return file.previousPath === undefined ? file.path : `${file.previousPath} -> ${file.path}`
}

/** Groups changed files by directory. Folders sort before files, and both sort by name. */
export function buildDiffTree(files: readonly DiffFile[]): DiffTreeNode[] {
  const top: MutableFolder = { name: '', path: '', folders: new Map(), files: [], additions: 0, deletions: 0 }
  for (const file of files) {
    const segments = file.path.split('/')
    const leafName = segments.at(-1) ?? file.path
    const chain: MutableFolder[] = []
    let parent = top
    for (const segment of segments.slice(0, -1)) {
      let folder = parent.folders.get(segment)
      if (!folder) {
        const path = parent.path === '' ? segment : `${parent.path}/${segment}`
        folder = { name: segment, path, folders: new Map(), files: [], additions: 0, deletions: 0 }
        parent.folders.set(segment, folder)
      }
      chain.push(folder)
      parent = folder
    }
    for (const folder of chain) {
      folder.additions += file.additions
      folder.deletions += file.deletions
    }
    parent.files.push({ kind: 'file', name: leafName, path: file.path, file })
  }
  return freezeChildren(top)
}

function freezeChildren(folder: MutableFolder): DiffTreeNode[] {
  const folders: DiffTreeNode[] = [...folder.folders.values()]
    .sort((a, b) => compareNames(a.name, b.name))
    .map(child => ({
      kind: 'folder' as const,
      name: child.name,
      path: child.path,
      children: freezeChildren(child),
      additions: child.additions,
      deletions: child.deletions,
    }))
  const files: DiffTreeNode[] = [...folder.files].sort((a, b) => compareNames(a.name, b.name))
  return [...folders, ...files]
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Every folder path in the tree, for collapse-all. */
export function folderPaths(nodes: readonly DiffTreeNode[]): string[] {
  return nodes.flatMap(node => (node.kind === 'folder' ? [node.path, ...folderPaths(node.children)] : []))
}
