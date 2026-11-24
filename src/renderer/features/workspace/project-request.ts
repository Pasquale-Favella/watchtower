import type { ProjectId } from '@/shared/schemas/workspace.js'

/**
 * The read of the open Project that every conversation view shares. It is one selection for the whole window,
 * so a view that asks for nothing while another asks for the Project clears the other's read on every render,
 * and the two keep reselecting until the Project never loads. A Project of any kind, including "No project",
 * is therefore always asked for; only a view with no Project at all asks for nothing.
 */
export function openProjectRequest(projectId: ProjectId | null | undefined): { readonly projectId: ProjectId } | null {
  return projectId ? { projectId } : null
}
