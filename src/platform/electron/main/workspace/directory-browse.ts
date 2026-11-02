import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  WORKSPACE_DIRECTORY_BROWSE_LIMIT,
  type WorkspaceDirectoryListing,
} from '@/shared/schemas/workspace-projects.js'

const UNLISTABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path
}

const hasGitEntry = (directory: string) =>
  access(join(directory, '.git')).then(
    () => true,
    () => false,
  )

/** Lists a directory's immediate subfolders, sorted; a missing or unreadable directory lists as empty.
 * `isRepository` only checks for a `.git` entry, a hint for the add action rather than checkout identity.
 */
export async function browseDirectories(directoryPath: string, home = homedir()): Promise<WorkspaceDirectoryListing> {
  const parentPath = resolve(expandHome(directoryPath, home))
  let exists = true
  const dirents = await readdir(parentPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (!error.code || !UNLISTABLE.has(error.code)) throw error
    exists = error.code === 'EACCES' || error.code === 'EPERM'
    return []
  })
  const folders = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => ({ name: dirent.name, fullPath: join(parentPath, dirent.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, WORKSPACE_DIRECTORY_BROWSE_LIMIT)
  const [isRepository, ...repositories] = await Promise.all([
    exists ? hasGitEntry(parentPath) : false,
    ...folders.map(folder => hasGitEntry(folder.fullPath)),
  ])
  return {
    parentPath,
    exists,
    isRepository: isRepository ?? false,
    entries: folders.map((folder, index) => ({ ...folder, isRepository: repositories[index] ?? false })),
  }
}
