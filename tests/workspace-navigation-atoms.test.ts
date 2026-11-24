import { AtomRegistry } from 'effect/reactivity'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  hydrateWorkspaceNavigation,
  updateWorkspaceNavigationAtom,
  workspaceNavigationAtom,
} from '@/renderer/features/workspace/navigation-atoms.js'
import {
  defaultWorkspaceNavigationState,
  type WorkspaceNavigationStorage,
} from '@/renderer/features/workspace/workspace-navigation.js'
import { conversationIdSchema, projectIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'

class MemoryStorage implements WorkspaceNavigationStorage {
  value: string | null = null
  writes: Array<{ key: string; value: string }> = []

  getItem(): string | null {
    return this.value
  }

  setItem(key: string, value: string): void {
    this.value = value
    this.writes.push({ key, value })
  }
}

const storedSelection = {
  projectId: Schema.decodeUnknownSync(projectIdSchema)('project-1'),
  taskId: Schema.decodeUnknownSync(taskIdSchema)('task-2'),
  conversationId: Schema.decodeUnknownSync(conversationIdSchema)('conversation-3'),
  navigationCollapsed: true,
}

describe('workspace navigation atoms', () => {
  it('hydrates the saved selection once and persists subsequent updates', () => {
    const storage = new MemoryStorage()
    storage.value = JSON.stringify(storedSelection)
    const registry = AtomRegistry.make()

    hydrateWorkspaceNavigation(registry, storage)
    expect(registry.get(workspaceNavigationAtom)).toEqual(storedSelection)

    registry.set(updateWorkspaceNavigationAtom, { taskId: null, conversationId: null })
    expect(registry.get(workspaceNavigationAtom)).toEqual({ ...storedSelection, taskId: null, conversationId: null })
    const persisted = storage.writes[0]?.value
    expect(persisted ? JSON.parse(persisted) : null).toEqual({
      ...storedSelection,
      taskId: null,
      conversationId: null,
    })
  })

  it('does not let another mounted consumer overwrite the window selection with defaults', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    hydrateWorkspaceNavigation(registry, storage)
    registry.set(updateWorkspaceNavigationAtom, { projectId: storedSelection.projectId })

    hydrateWorkspaceNavigation(registry, new MemoryStorage())
    expect(registry.get(workspaceNavigationAtom)).toEqual({
      ...defaultWorkspaceNavigationState,
      projectId: storedSelection.projectId,
    })
  })

  it('keeps navigation isolated by window registry', () => {
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()
    const firstStorage = new MemoryStorage()
    const secondStorage = new MemoryStorage()
    firstStorage.value = JSON.stringify(storedSelection)

    hydrateWorkspaceNavigation(first, firstStorage)
    hydrateWorkspaceNavigation(second, secondStorage)
    first.set(updateWorkspaceNavigationAtom, { taskId: null })

    expect(first.get(workspaceNavigationAtom).taskId).toBeNull()
    expect(second.get(workspaceNavigationAtom)).toEqual(defaultWorkspaceNavigationState)
    expect(secondStorage.writes).toEqual([])
  })
})
