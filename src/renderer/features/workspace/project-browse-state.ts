import type { Hotkey } from '@tanstack/react-hotkeys'

import type { RemoteSourceReadiness } from '@/shared/schemas/workspace-projects.js'

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

export type BrowseTabAction =
  | { readonly kind: 'activate' }
  | { readonly kind: 'descend'; readonly name: string }
  | { readonly kind: 'extend'; readonly name: string }

/**
 * What Tab does in the folder input: open the highlighted row, enter the single match, or extend to the common
 * prefix. `null` means there is nothing to complete, so Tab must keep its normal focus movement.
 */
export function browseTabAction(input: {
  readonly browsing: boolean
  readonly hasActiveRow: boolean
  readonly hasDirectory: boolean
  readonly visible: readonly BrowseEntry[]
  readonly leaf: string
}): BrowseTabAction | null {
  if (!input.browsing) return null
  if (input.hasActiveRow) return { kind: 'activate' }
  const completion = browseTabCompletion(input.visible, input.leaf)
  if (completion === null) return null
  if (completion.complete) return { kind: 'descend', name: completion.name }
  return input.hasDirectory ? { kind: 'extend', name: completion.name } : null
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

/** What Enter does for the browsed target: register an existing folder, or create it first. Git is never involved. */
export type BrowseAddAction = 'add' | 'create'

export const ADD_ACTION_LABELS: Record<BrowseAddAction, string> = { add: 'Add', create: 'Create & Add' }
export const ADD_ACTION_HINTS: Record<BrowseAddAction, string | null> = {
  add: null,
  create: 'Press Enter to create this folder and add it as a project.',
}

export function browseAddAction(
  query: string,
  listing: { readonly exists: boolean },
  exact: BrowseEntry | null,
): BrowseAddAction {
  if (!hasTrailingSeparator(query)) return exact ? 'add' : 'create'
  return listing.exists ? 'add' : 'create'
}

/** The ways to add a project, in the order the source list shows them. */
export type ProjectSourceId = 'new' | 'local' | 'git' | 'github'

export function githubDescription(readiness: RemoteSourceReadiness['github'] | null): string {
  switch (readiness) {
    case 'ready':
      return 'owner/repository through GitHub CLI'
    case 'unauthenticated':
      return 'Sign in first: run gh auth login'
    case 'unavailable':
      return 'Requires GitHub CLI (gh)'
    default:
      return 'Checking GitHub CLI…'
  }
}

export function projectSources(
  readiness: RemoteSourceReadiness['github'] | null,
): readonly { readonly id: ProjectSourceId; readonly title: string; readonly description: string }[] {
  return [
    { id: 'new', title: 'New project', description: 'Start a new Git repository from a name' },
    { id: 'local', title: 'Local folder', description: 'Browse a folder on disk' },
    { id: 'git', title: 'Clone from Git URL', description: 'Clone from a remote URL' },
    { id: 'github', title: 'Clone from GitHub', description: githubDescription(readiness) },
  ]
}

/** Keys of the add-project palette's input. */
export const PALETTE_NEXT_HOTKEY: Hotkey = 'ArrowDown'
export const PALETTE_PREVIOUS_HOTKEY: Hotkey = 'ArrowUp'
export const PALETTE_SUBMIT_HOTKEY: Hotkey = 'Enter'
export const PALETTE_FORCE_SUBMIT_HOTKEY: Hotkey = 'Mod+Enter'
export const PALETTE_COMPLETE_HOTKEY: Hotkey = 'Tab'
export const PALETTE_BACK_HOTKEY: Hotkey = 'Backspace'
export const PALETTE_CLOSE_HOTKEY: Hotkey = 'Escape'

export type PaletteEnterIntent = 'activate' | 'submit' | 'none'

/** Enter submits the typed value unless a row is active, which it activates instead; Mod+Enter submits regardless. */
export function paletteEnterIntent(input: {
  readonly forceSubmit: boolean
  readonly hasActiveRow: boolean
  readonly hasSubmit: boolean
  readonly submitDisabled: boolean
}): PaletteEnterIntent {
  if (input.hasActiveRow && !(input.forceSubmit && input.hasSubmit)) return 'activate'
  return input.hasSubmit && !input.submitDisabled ? 'submit' : 'none'
}

/** The row an arrow key moves to, wrapping at both ends; with nothing active Down starts at the top and Up at the bottom. */
export function paletteMoveTarget(ids: readonly string[], activeId: string | null, offset: 1 | -1): string | null {
  if (ids.length === 0) return null
  const current = activeId === null ? -1 : ids.indexOf(activeId)
  if (current === -1) return (offset === 1 ? ids[0] : ids[ids.length - 1]) ?? null
  return ids[(current + offset + ids.length) % ids.length] ?? null
}

/** Backspace leaves the step only from an empty input, so it never swallows a delete, held-key repeats included. */
export function paletteBackspaceGoesBack(input: { readonly value: string; readonly repeat: boolean }): boolean {
  return input.value === '' && !input.repeat
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
