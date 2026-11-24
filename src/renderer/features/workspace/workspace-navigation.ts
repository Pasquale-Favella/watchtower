import * as Schema from 'effect/Schema'

import { conversationIdSchema, projectIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'

const STORAGE_KEY = 'watchtower.workspace.navigation.v1'
const storedStateSchema = Schema.Struct({
  projectId: Schema.NullOr(projectIdSchema),
  taskId: Schema.NullOr(taskIdSchema),
  conversationId: Schema.NullOr(conversationIdSchema),
  navigationCollapsed: Schema.Boolean,
})

export type WorkspaceNavigationState = Schema.Schema.Type<typeof storedStateSchema>
export type WorkspaceNavigationStorage = Pick<Storage, 'getItem' | 'setItem'>

export const defaultWorkspaceNavigationState: WorkspaceNavigationState = {
  projectId: null,
  taskId: null,
  conversationId: null,
  navigationCollapsed: false,
}

export function readWorkspaceNavigation(storage: Pick<Storage, 'getItem'> | null): WorkspaceNavigationState {
  if (!storage) return defaultWorkspaceNavigationState
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return stored ? Schema.decodeUnknownSync(storedStateSchema)(JSON.parse(stored)) : defaultWorkspaceNavigationState
  } catch {
    return defaultWorkspaceNavigationState
  }
}

export function writeWorkspaceNavigation(
  storage: Pick<Storage, 'setItem'> | null,
  state: WorkspaceNavigationState,
): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Navigation still works for this window when storage is unavailable.
  }
}

export function mergeWorkspaceNavigation(
  current: WorkspaceNavigationState,
  update: Partial<WorkspaceNavigationState>,
): WorkspaceNavigationState {
  return { ...current, ...update }
}
