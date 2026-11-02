import { useState } from 'react'

import { Dialog, DialogContent, DialogTitle } from '@/renderer/components/ui/dialog'
import type { ProjectRemoteSource, WorkspaceProjectRegistration } from '@/shared/schemas/workspace-projects.js'

import { useCloneProject, useCreateProject, useRegisterProject } from './hooks.js'
import { fileManagerName } from './platform-labels.js'
import {
  browseDirectoryOf,
  cloneFolderName,
  INITIAL_BROWSE_QUERY,
  isBrowsePath,
  projectNameOf,
} from './project-browse-state.js'
import {
  useChooseWorkspaceProjectDirectory,
  useLookupGitHubRepository,
  useRemoteSourceReadiness,
} from './project-directory-hooks.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'
import { useWorkspaceNavigation } from './use-workspace-navigation.js'
import { FooterAction } from './WorkspaceAddProjectFrame.js'
import {
  BrowseView,
  NewProjectView,
  RemoteRepositorySummary,
  RemoteRepositoryView,
  type RemoteSourceKind,
  SourcesView,
} from './WorkspaceAddProjectViews.js'

interface CloneTarget {
  readonly source: ProjectRemoteSource
  readonly title: string
  readonly description: string
  readonly folder: string
}

type View =
  | { readonly kind: 'sources' }
  | { readonly kind: 'browse' }
  | { readonly kind: 'new' }
  | { readonly kind: 'remote'; readonly source: RemoteSourceKind }
  | { readonly kind: 'destination'; readonly clone: CloneTarget }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed. Try again.'
}

export function WorkspaceProjectDialog(): React.JSX.Element {
  const dialog = useWorkspaceProjectDialog()
  return (
    <Dialog
      open={dialog.isOpen}
      onOpenChange={open => {
        if (open) dialog.open()
        else dialog.close()
      }}
    >
      <DialogContent showCloseButton={false} className="top-[15vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Add project</DialogTitle>
        <AddProjectPalette />
      </DialogContent>
    </Dialog>
  )
}

/** Mounted per open, so each open starts from the source list with fresh readiness and listings. */
function AddProjectPalette() {
  const dialog = useWorkspaceProjectDialog()
  const { selectProject } = useWorkspaceNavigation()
  const register = useRegisterProject()
  const create = useCreateProject()
  const clone = useCloneProject()
  const lookup = useLookupGitHubRepository()
  const picker = useChooseWorkspaceProjectDirectory()
  const readiness = useRemoteSourceReadiness().data?.github ?? null
  const [view, setView] = useState<View>({ kind: 'sources' })
  const [browseQuery, setBrowseQuery] = useState(INITIAL_BROWSE_QUERY)
  const [error, setError] = useState<string | null>(null)
  const busy = register.pending || create.pending || clone.pending || picker.pending

  const go = (next: View) => {
    setError(null)
    setView(next)
  }
  const back = () => go({ kind: 'sources' })
  const browseDirectory = isBrowsePath(browseQuery) ? browseDirectoryOf(browseQuery) : INITIAL_BROWSE_QUERY

  const run = async (operation: () => Promise<WorkspaceProjectRegistration>) => {
    setError(null)
    try {
      const receipt = await operation()
      selectProject(receipt.project.id)
      dialog.showNotice(
        receipt.reused ? `Using the existing Project "${receipt.project.name}".` : `Added "${receipt.project.name}".`,
      )
      dialog.close()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const openFromFileManager = async () => {
    setError(null)
    try {
      const selected = await picker.execute()
      if (selected) await run(() => register.execute({ path: selected, name: projectNameOf(selected) }))
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const fileManager = (
    <FooterAction disabled={busy} onClick={() => void openFromFileManager()}>
      {`Open in ${fileManagerName}`}
    </FooterAction>
  )

  const continueRemote = async (kind: RemoteSourceKind, value: string) => {
    setError(null)
    if (kind === 'git') {
      go({
        kind: 'destination',
        clone: {
          source: { _tag: 'git', remoteUrl: value },
          title: value,
          description: 'Git URL',
          folder: cloneFolderName(value),
        },
      })
      return
    }
    try {
      const repository = await lookup.execute(value)
      go({
        kind: 'destination',
        clone: {
          source: { _tag: 'github', repository: repository.nameWithOwner },
          title: repository.nameWithOwner,
          description: repository.url,
          folder: cloneFolderName(repository.nameWithOwner),
        },
      })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  switch (view.kind) {
    case 'sources':
      return (
        <SourcesView
          readiness={readiness}
          error={error}
          footerTrailing={fileManager}
          onLocal={() => go({ kind: 'browse' })}
          onNew={() => go({ kind: 'new' })}
          onRemote={source => go({ kind: 'remote', source })}
        />
      )
    case 'browse':
      return (
        <BrowseView
          query={browseQuery}
          onQueryChange={value => {
            setError(null)
            setBrowseQuery(value)
          }}
          busy={busy}
          busyLabel="Adding"
          error={error}
          footerTrailing={fileManager}
          onBack={back}
          onSubmit={(path, action) => {
            const name = projectNameOf(path)
            void run(() =>
              action === 'add' ? register.execute({ path, name }) : create.execute({ path, name, publish: 'none' }),
            )
          }}
        />
      )
    case 'new':
      return (
        <NewProjectView
          baseQuery={browseQuery}
          readiness={readiness}
          busy={busy}
          error={error}
          onBack={back}
          onSubmit={(path, name, publish) =>
            void run(() => create.execute({ path, name, publish: publish ? 'github-private' : 'none' }))
          }
        />
      )
    case 'remote':
      return (
        <RemoteRepositoryView
          kind={view.source}
          busy={lookup.pending}
          error={error}
          onBack={back}
          onContinue={value => void continueRemote(view.source, value)}
        />
      )
    case 'destination':
      return (
        <DestinationView
          key={view.clone.title}
          clone={view.clone}
          initialQuery={`${browseDirectory}${view.clone.folder}`}
          busy={busy}
          error={error}
          onBack={() => go({ kind: 'remote', source: view.clone.source._tag })}
          onClone={path =>
            void run(() => clone.execute({ path, name: projectNameOf(path), source: view.clone.source }))
          }
          onQueryChange={() => setError(null)}
        />
      )
  }
}

function DestinationView({
  clone,
  initialQuery,
  busy,
  error,
  onBack,
  onClone,
  onQueryChange,
}: {
  readonly clone: CloneTarget
  readonly initialQuery: string
  readonly busy: boolean
  readonly error: string | null
  readonly onBack: () => void
  readonly onClone: (path: string) => void
  readonly onQueryChange: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  return (
    <BrowseView
      query={query}
      onQueryChange={value => {
        onQueryChange()
        setQuery(value)
      }}
      cloneFolder={clone.folder}
      header={<RemoteRepositorySummary title={clone.title} description={clone.description} />}
      busy={busy}
      busyLabel="Cloning"
      error={error}
      onBack={onBack}
      onSubmit={path => onClone(path)}
    />
  )
}
