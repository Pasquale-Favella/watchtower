import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import { openProjectRequest } from '@/renderer/features/workspace/project-request.js'
import { createQuerySelectionState } from '@/renderer/stores/atoms/query-slot.js'
import { projectIdSchema } from '@/shared/schemas/workspace.js'

const scratch = projectIdSchema.make('workspace-scratch-project')
const repository = projectIdSchema.make('project-repository')

describe('the open Project read shared by conversation views', () => {
  it('asks for the Project of a "No project" chat like any other', () => {
    expect(openProjectRequest(scratch)).toEqual({ projectId: scratch })
    expect(openProjectRequest(repository)).toEqual({ projectId: repository })
  })

  it('asks for nothing only when there is no Project at all', () => {
    expect(openProjectRequest(null)).toBeNull()
    expect(openProjectRequest(undefined)).toBeNull()
  })

  it('shows why: one view asking for nothing discards the selection another view made', () => {
    const registry = AtomRegistry.make()
    let selections = 0
    const { requestAtom } = createQuerySelectionState<{ readonly projectId: string }, never>(
      request => request.projectId,
      (request, key) => {
        selections += 1
        return { request, key } as never
      },
    )
    registry.set(requestAtom, openProjectRequest(scratch))
    // The same Project again is a no-op, so views that agree never disturb each other.
    registry.set(requestAtom, openProjectRequest(scratch))
    expect(selections).toBe(1)
    // A view that asked for nothing would clear it, and the next view would have to start the read over.
    registry.set(requestAtom, null)
    registry.set(requestAtom, openProjectRequest(scratch))
    expect(selections).toBe(2)
  })
})
