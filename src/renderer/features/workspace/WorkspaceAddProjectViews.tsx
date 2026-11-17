import * as Schema from 'effect/Schema'
import {
  CornerLeftUp,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Github,
  Link,
  Square,
  SquareCheck,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import {
  githubRepositorySchema,
  gitRemoteUrlSchema,
  type RemoteSourceReadiness,
} from '@/shared/schemas/workspace-projects.js'

import {
  appendBrowseSegment,
  type BrowseAddAction,
  browseAddAction,
  browseDirectoryOf,
  browseLeafOf,
  browseParentOf,
  browseTabCompletion,
  filterBrowseEntries,
  hasTrailingSeparator,
  INITIAL_BROWSE_QUERY,
  isBrowsePath,
  isValidFolderName,
  joinBrowsePath,
  projectNameOf,
  resolveBrowseTarget,
} from './project-browse-state.js'
import { useWorkspaceDirectoryListing } from './project-directory-hooks.js'
import { type PaletteRow, WorkspaceAddProjectFrame } from './WorkspaceAddProjectFrame.js'

export type RemoteSourceKind = 'github' | 'git'

const isGitHubRepository = Schema.is(githubRepositorySchema)
const isGitRemoteUrl = Schema.is(gitRemoteUrlSchema)

function githubDescription(readiness: RemoteSourceReadiness['github'] | null): string {
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

export function SourcesView({
  readiness,
  error,
  footerTrailing,
  onLocal,
  onNew,
  onRemote,
}: {
  readonly readiness: RemoteSourceReadiness['github'] | null
  readonly error: string | null
  readonly footerTrailing: ReactNode
  readonly onLocal: () => void
  readonly onNew: () => void
  readonly onRemote: (kind: RemoteSourceKind) => void
}) {
  const [query, setQuery] = useState('')
  const rows: PaletteRow[] = [
    {
      id: 'local',
      icon: <FolderOpen />,
      title: 'Local folder',
      description: 'Browse to a folder on this computer',
      onActivate: onLocal,
    },
    {
      id: 'new',
      icon: <FolderPlus />,
      title: 'New project',
      description: 'Create a folder with an empty Git repository',
      onActivate: onNew,
    },
    {
      id: 'github',
      icon: <Github />,
      title: 'Clone from GitHub',
      description: githubDescription(readiness),
      disabled: readiness !== 'ready',
      onActivate: () => onRemote('github'),
    },
    {
      id: 'git',
      icon: <Link />,
      title: 'Clone from Git URL',
      description: 'HTTPS, SSH or a local repository path',
      onActivate: () => onRemote('git'),
    },
  ]
  const needle = query.trim().toLowerCase()
  const visible = rows.filter(row => row.title.toLowerCase().includes(needle))
  return (
    <WorkspaceAddProjectFrame
      inputLabel="Add project"
      placeholder="Add a project…"
      value={query}
      onValueChange={setQuery}
      icon={<FolderPlus />}
      resetKey={needle}
      rows={visible}
      autoHighlight
      error={error}
      emptyMessage={visible.length === 0 ? 'No matching options.' : null}
      footerTrailing={footerTrailing}
    />
  )
}

const ADD_LABELS: Record<BrowseAddAction, string> = { add: 'Add', init: 'Init & Add', create: 'Create & Add' }
const ADD_HINTS: Record<BrowseAddAction, string | null> = {
  add: null,
  init: 'This folder is not a Git repository yet. Enter runs git init and adds it.',
  create: 'This folder does not exist. Enter creates it with an empty Git repository.',
}

/** Local folders and clone destinations share one browser; a clone keeps its folder name pinned as the leaf. */
export function BrowseView({
  query,
  onQueryChange,
  cloneFolder,
  header,
  busy,
  busyLabel,
  error,
  footerTrailing,
  onBack,
  onSubmit,
}: {
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly cloneFolder?: string
  readonly header?: ReactNode
  readonly busy: boolean
  readonly busyLabel: string
  readonly error: string | null
  readonly footerTrailing?: ReactNode
  readonly onBack: () => void
  readonly onSubmit: (path: string, action: BrowseAddAction | 'clone') => void
}) {
  const browsing = isBrowsePath(query)
  const directory = browsing ? browseDirectoryOf(query) : null
  const request = useMemo(() => (directory ? { directoryPath: directory } : null), [directory])
  const listing = useWorkspaceDirectoryListing(request)
  const leaf = browseLeafOf(query)
  const filterLeaf = cloneFolder !== undefined && leaf === cloneFolder ? '' : leaf
  const entries = listing.data?.entries ?? []
  const { visible } = filterBrowseEntries(entries, filterLeaf)
  const exact = leaf ? (entries.find(entry => entry.name === leaf) ?? null) : null
  const pinned = cloneFolder ?? ''
  const parent =
    directory && (cloneFolder !== undefined || hasTrailingSeparator(query)) ? browseParentOf(directory) : null
  const target = resolveBrowseTarget(query, listing.data?.parentPath ?? null, exact)
  const action =
    cloneFolder !== undefined ? 'clone' : listing.data ? browseAddAction(query, listing.data, exact) : 'add'
  const canSubmit = browsing && listing.data !== null && !busy && projectNameOf(target) !== ''

  const browseTo = (name: string) => onQueryChange(`${appendBrowseSegment(directory ?? query, name)}${pinned}`)
  const goUp = () => {
    if (parent) onQueryChange(`${parent}${pinned}`)
  }
  const rows: PaletteRow[] = [
    ...(parent ? [{ id: 'browse:up', icon: <CornerLeftUp />, title: '..', onActivate: goUp }] : []),
    ...visible.map(entry => ({
      id: entry.fullPath,
      icon: entry.isRepository ? <FolderGit2 /> : <Folder />,
      title: entry.name,
      onActivate: () => browseTo(entry.name),
    })),
  ]

  const emptyMessage = !browsing
    ? 'Type an absolute path, or start with ~/ for your home folder.'
    : listing.error
      ? null
      : listing.data === null
        ? 'Loading folders…'
        : rows.length === 0 && action === 'add'
          ? 'No folders here.'
          : null

  return (
    <WorkspaceAddProjectFrame
      inputLabel="Project folder"
      placeholder={cloneFolder !== undefined ? 'Choose where to clone' : 'Enter project path (e.g. ~/projects/my-app)'}
      value={query}
      onValueChange={onQueryChange}
      icon={<FolderPlus />}
      onBack={onBack}
      disabled={busy}
      resetKey={directory ?? ''}
      rows={rows}
      groupLabel={cloneFolder !== undefined ? 'Select where to clone' : 'Directories'}
      submit={{
        label: busy ? busyLabel : action === 'clone' ? 'Clone' : ADD_LABELS[action],
        disabled: !canSubmit,
        onSubmit: () => onSubmit(target, action),
      }}
      onTab={active => {
        if (!browsing) return
        if (active) {
          active.onActivate()
          return
        }
        const completion = browseTabCompletion(visible, filterLeaf)
        if (completion?.complete) browseTo(completion.name)
        else if (completion && directory) onQueryChange(`${directory}${completion.name}`)
      }}
      header={header}
      hint={action === 'clone' || listing.data === null ? null : ADD_HINTS[action]}
      emptyMessage={emptyMessage}
      error={error ?? listing.error}
      footerTrailing={footerTrailing}
    />
  )
}

export function NewProjectView({
  baseQuery,
  readiness,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  readonly baseQuery: string
  readonly readiness: RemoteSourceReadiness['github'] | null
  readonly busy: boolean
  readonly error: string | null
  readonly onBack: () => void
  readonly onSubmit: (path: string, name: string, publish: boolean) => void
}) {
  const [name, setName] = useState('')
  const [publish, setPublish] = useState(false)
  const directory = isBrowsePath(baseQuery) ? browseDirectoryOf(baseQuery) : INITIAL_BROWSE_QUERY
  const request = useMemo(() => ({ directoryPath: directory }), [directory])
  const listing = useWorkspaceDirectoryListing(request)
  const trimmed = name.trim()
  const parentPath = listing.data?.parentPath ?? null
  const path = parentPath && isValidFolderName(trimmed) ? joinBrowsePath(parentPath, trimmed) : null
  const taken = Boolean(listing.data?.entries.some(entry => entry.name.toLowerCase() === trimmed.toLowerCase()))
  const canPublish = readiness === 'ready'
  const rows: PaletteRow[] = [
    {
      id: 'publish',
      icon: <Github />,
      title: 'Create private repository on GitHub',
      description: canPublish ? 'Adds it as origin through GitHub CLI' : githubDescription(readiness),
      disabled: !canPublish || busy,
      trailing: publish && canPublish ? <SquareCheck /> : <Square />,
      onActivate: () => setPublish(value => !value),
    },
  ]
  return (
    <WorkspaceAddProjectFrame
      inputLabel="Project name"
      placeholder="Project name"
      value={name}
      onValueChange={setName}
      icon={<FolderPlus />}
      onBack={onBack}
      disabled={busy}
      resetKey="new-project"
      rows={rows}
      groupLabel="Options"
      submit={{
        label: busy ? 'Creating' : 'Create',
        disabled: busy || path === null || taken,
        onSubmit: () => path && onSubmit(path, trimmed, publish && canPublish),
      }}
      header={
        <p className="text-muted-foreground border-b px-4 py-2 text-xs">
          {taken
            ? `A folder named ${trimmed} already exists here.`
            : path
              ? `Creates ${path}`
              : `New folder in ${parentPath ?? directory}`}
        </p>
      }
      error={error ?? listing.error}
    />
  )
}

export function RemoteRepositoryView({
  kind,
  busy,
  error,
  onBack,
  onContinue,
}: {
  readonly kind: RemoteSourceKind
  readonly busy: boolean
  readonly error: string | null
  readonly onBack: () => void
  readonly onContinue: (value: string) => void
}) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  const valid = kind === 'github' ? isGitHubRepository(trimmed) : isGitRemoteUrl(trimmed)
  const label = kind === 'github' ? 'Look up' : 'Continue'
  return (
    <WorkspaceAddProjectFrame
      inputLabel={kind === 'github' ? 'GitHub repository' : 'Git URL'}
      placeholder={kind === 'github' ? 'owner/repository' : 'https://example.com/owner/repository.git'}
      value={value}
      onValueChange={setValue}
      icon={kind === 'github' ? <Github /> : <Link />}
      onBack={onBack}
      disabled={busy}
      resetKey={kind}
      rows={[]}
      submit={{ label: busy ? 'Looking up' : label, disabled: busy || !valid, onSubmit: () => onContinue(trimmed) }}
      error={error}
      emptyMessage={
        kind === 'github'
          ? 'Enter owner/repository and press Enter to look it up.'
          : 'Enter a Git clone URL and press Enter to continue.'
      }
    />
  )
}

export function RemoteRepositorySummary({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
      <FolderGit2 aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">{description}</span>
      </span>
    </div>
  )
}
