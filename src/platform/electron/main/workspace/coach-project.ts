import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { ensureManagedChatProject } from '@/platform/electron/main/workspace/scratch-project.js'

export const ensureCoachProject = (store: WorkspaceStore['Service'], directory: string) =>
  ensureManagedChatProject(store, directory, 'coach')

/** Call once during application startup, before the first Workspace request. */
export const sweepCoachChats = (store: WorkspaceStore['Service']) => store.sweepCoachChats()
