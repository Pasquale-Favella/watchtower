import type { WorkspaceCheckout } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectDetail } from '@/shared/schemas/workspace-store.js'

/**
 * Diff compares a Git checkout with its repository. A "No project" chat, the Coach chat and any folder registered
 * without Git work in a plain 'directory' checkout (a legacy Coach folder may still have a repository, which is
 * never used), so there is nothing to compare and the entry points stay hidden.
 * Available until the Project has loaded, so a Diff tab the user already has open is never closed by a load.
 */
export function isDiffAvailable(
  detail: Pick<WorkspaceProjectDetail, 'project' | 'mainCheckout'> | null | undefined,
  checkout?: Pick<WorkspaceCheckout, 'kind'> | null,
): boolean {
  if (!detail) return true
  if (detail.project.isScratch || detail.project.isCoach) return false
  return (checkout ?? detail.mainCheckout).kind !== 'directory'
}
