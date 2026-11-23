import type { ReactElement } from 'react'

import { displayShortcutForAction } from '@/renderer/app/shortcuts'
import { Button } from '@/renderer/components/ui/button'
import { Kbd } from '@/renderer/components/ui/kbd'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceProjectDialog } from './use-project-dialog.js'

type ProjectItem = WorkspaceProjectReadPage['items'][number]

/**
 * Whether the new-chat view should greet the user with the zero-projects welcome. The internal No project
 * and Coach projects and archived projects are not registered projects the user can pick. `null` means the
 * project list has not loaded yet; a further page means more projects may exist, so nothing is claimed.
 */
// eslint-disable-next-line react-refresh/only-export-components -- a pure predicate kept beside the one component that uses it.
export function shouldShowNoProjectsWelcome(projects: readonly ProjectItem[] | null, hasMore = false): boolean {
  if (projects === null || hasMore) return false
  return !projects.some(project => !project.isScratch && !project.isCoach && !project.archivedAt)
}

/** The new-chat welcome when no project is registered: add one, or start without one. The composer stays
 *  usable underneath. */
export function WorkspaceNoProjectsWelcome({
  onStartWithoutProject,
  disabled = false,
}: {
  readonly onStartWithoutProject: () => void
  readonly disabled?: boolean
}): ReactElement {
  const projectDialog = useWorkspaceProjectDialog()
  const addProjectShortcut = displayShortcutForAction('addProject')
  const withoutProjectShortcut = displayShortcutForAction('newChatWithoutProject')
  return (
    <div className="mb-8 flex w-full flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <h2 className="text-foreground text-[20px] font-semibold tracking-tight">What should we work on?</h2>
        <p className="text-muted-foreground max-w-lg text-[13px] leading-[1.7]">Add a project, or start without one.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" disabled={disabled} onClick={projectDialog.open}>
          Add project
          {addProjectShortcut && <Kbd>{addProjectShortcut}</Kbd>}
        </Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={onStartWithoutProject}>
          Start without a project
          {withoutProjectShortcut && <Kbd>{withoutProjectShortcut}</Kbd>}
        </Button>
      </div>
    </div>
  )
}
