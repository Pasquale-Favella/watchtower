import type { Project, WorkspaceCheckout, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

interface ProjectCheckout {
  readonly project: Pick<Project, 'isScratch' | 'isCoach' | 'archivedAt'>
  readonly mainCheckout: Pick<WorkspaceCheckout, 'id' | 'kind' | 'archivedAt'>
}

export function shouldShowInitializeGit(
  detail: ProjectCheckout | null | undefined,
  checkoutId?: WorkspaceCheckoutId,
): boolean {
  if (!detail) return false
  const { project, mainCheckout } = detail
  return (
    !project.isScratch &&
    !project.isCoach &&
    !project.archivedAt &&
    !mainCheckout.archivedAt &&
    mainCheckout.kind === 'directory' &&
    (checkoutId === undefined || checkoutId === mainCheckout.id)
  )
}
