import type { Project, WorkspaceCheckout, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

interface ProjectCheckout {
  readonly project: Pick<Project, 'isScratch' | 'isCoach' | 'archivedAt'>
  readonly mainCheckout: Pick<WorkspaceCheckout, 'id' | 'kind' | 'archivedAt'>
}

export const INITIALIZE_GIT_BUSY_REASON = 'Wait for the agent to finish.'
export const INITIALIZE_GIT_SUCCESS_MESSAGE = 'Git initialized'

/** Git init rewrites the folder under a running agent, so the row waits until no run is active. */
export function initializeGitBlockedReason(activeRun: boolean | undefined): string | null {
  return activeRun ? INITIALIZE_GIT_BUSY_REASON : null
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
