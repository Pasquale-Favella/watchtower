export interface BrowseEntry {
  readonly name: string
  readonly fullPath: string
}

export const INITIAL_BROWSE_QUERY = '~/'

/** A POSIX root only treats `/` as a separator; every other path also accepts `\`. */
function separatorPattern(path: string): RegExp {
  return path.startsWith('/') ? /\// : /[\\/]/
}

function lastSeparatorIndex(path: string): number {
  return path.startsWith('/') ? path.lastIndexOf('/') : Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

function preferredSeparator(path: string): '/' | '\\' {
  if (/^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\')) return '\\'
  if (path.startsWith('/')) return '/'
  return path.includes('\\') ? '\\' : '/'
}

function splitRoot(path: string): { readonly root: string; readonly segments: readonly string[] } | null {
  const root =
    /^[a-zA-Z]:[\\/]/.exec(path)?.[0] ??
    /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.exec(path)?.[0] ??
    /^~[\\/]/.exec(path)?.[0] ??
    (path.startsWith('/') ? '/' : null)
  if (root === null) return null
  return { root, segments: path.slice(root.length).split(separatorPattern(path)).filter(Boolean) }
}

export function isBrowsePath(query: string): boolean {
  return splitRoot(query) !== null
}

export function hasTrailingSeparator(query: string): boolean {
  return new RegExp(`${separatorPattern(query).source}$`).test(query)
}

export function browseDirectoryOf(query: string): string {
  return hasTrailingSeparator(query) ? query : query.slice(0, lastSeparatorIndex(query) + 1)
}

export function browseLeafOf(query: string): string {
  return hasTrailingSeparator(query) ? '' : query.slice(lastSeparatorIndex(query) + 1)
}

/** The directory one level up, or null at a root. */
export function browseParentOf(directory: string): string | null {
  const parts = splitRoot(directory)
  if (parts === null || parts.segments.length === 0) return null
  const separator = preferredSeparator(directory)
  return `${parts.root}${parts.segments
    .slice(0, -1)
    .map(segment => `${segment}${separator}`)
    .join('')}`
}

export function appendBrowseSegment(query: string, name: string): string {
  return `${browseDirectoryOf(query)}${name}${preferredSeparator(query)}`
}

export function filterBrowseEntries<Entry extends BrowseEntry>(entries: readonly Entry[], leaf: string) {
  const lowerLeaf = leaf.toLowerCase()
  const showHidden = leaf.startsWith('.')
  const visible = entries.filter(
    entry => entry.name.toLowerCase().startsWith(lowerLeaf) && (showHidden || !entry.name.startsWith('.')),
  )
  const exact = leaf.length > 0 ? (visible.find(entry => entry.name === leaf) ?? null) : null
  return { visible, exact }
}

/** Shell-style Tab: a single match enters the directory, several extend to their common prefix. */
export function browseTabCompletion(
  visible: readonly BrowseEntry[],
  leaf: string,
): { readonly name: string; readonly complete: boolean } | null {
  const [first, ...rest] = visible
  if (first === undefined) return null
  if (rest.length === 0) return { name: first.name, complete: true }
  let prefix = Array.from(first.name)
  for (const entry of rest) {
    const characters = Array.from(entry.name)
    let length = 0
    while (length < prefix.length && prefix[length]?.toLowerCase() === characters[length]?.toLowerCase()) length += 1
    prefix = prefix.slice(0, length)
  }
  const name = prefix.join('')
  return name.length > leaf.length ? { name, complete: false } : null
}

/** The absolute folder Enter adds: the listed directory, an exact match, or a new leaf under it. */
export function resolveBrowseTarget(query: string, parentPath: string | null, exact: BrowseEntry | null): string {
  if (exact) return exact.fullPath
  if (parentPath === null) return query.trim()
  const leaf = browseLeafOf(query)
  return leaf ? joinBrowsePath(parentPath, leaf) : parentPath
}

export function projectNameOf(path: string): string {
  return path.split(/[\\/]+/).findLast(Boolean) ?? ''
}

export function joinBrowsePath(directory: string, name: string): string {
  const separator = preferredSeparator(directory)
  return directory.endsWith('/') || directory.endsWith('\\') ? `${directory}${name}` : `${directory}${separator}${name}`
}

/** What Enter does for the browsed target: register a repository, `git init` a folder, or create it. */
export type BrowseAddAction = 'add' | 'init' | 'create'

export function browseAddAction(
  query: string,
  listing: { readonly exists: boolean; readonly isRepository: boolean },
  exact: { readonly isRepository: boolean } | null,
): BrowseAddAction {
  if (!hasTrailingSeparator(query)) return exact ? (exact.isRepository ? 'add' : 'init') : 'create'
  if (!listing.exists) return 'create'
  return listing.isRepository ? 'add' : 'init'
}

/** The folder a clone lands in: the repository name without a `.git` suffix. */
export function cloneFolderName(source: string): string {
  return (
    source
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .findLast(Boolean)
      ?.replace(/\.git$/i, '') ?? ''
  )
}

/** A folder name a user can type for a new project, without separators or reserved names. */
export function isValidFolderName(name: string): boolean {
  return /^[^\\/:*?"<>|\0]+$/.test(name) && name.trim() === name && name !== '.' && name !== '..'
}
