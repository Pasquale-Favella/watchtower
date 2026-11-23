import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { ensureManagedChatProject, managedChatProjectId } from '@/platform/electron/main/workspace/scratch-project.js'

/** The fixed id of the hidden Coach project; `ensureManagedChatProject` registers it under this id. */
export const COACH_PROJECT_ID = managedChatProjectId('coach')

export const ensureCoachProject = (store: WorkspaceStore['Service'], directory: string) =>
  ensureManagedChatProject(store, directory, 'coach')

/** Call once during application startup, before the first Workspace request. */
export const sweepCoachChats = (store: WorkspaceStore['Service']) => store.sweepCoachChats()
