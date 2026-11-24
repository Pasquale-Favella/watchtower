import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

type ProjectItem = WorkspaceProjectReadPage['items'][number]

/**
 * True when the user has registered no Project they can pick. The internal No project and Coach projects
 * and archived projects don't count. `null` means the list has not loaded yet, and a further page means
 * more projects may exist, so nothing is claimed in either case.
 */
export function hasNoUserProjects(projects: readonly ProjectItem[] | null, hasMore = false): boolean {
  if (projects === null || hasMore) return false
  return !projects.some(project => !project.isScratch && !project.isCoach && !project.archivedAt)
}
