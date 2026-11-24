import { describe, expect, it } from 'vitest'

import { hasNoUserProjects } from '@/renderer/features/workspace/project-list-state.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

type ProjectItem = WorkspaceProjectReadPage['items'][number]

const project = (overrides: Partial<ProjectItem> = {}): ProjectItem =>
  ({
    id: 'project-1' as ProjectId,
    name: 'Project',
    createdAt: '2026-11-23T10:00:00Z',
    updatedAt: '2026-11-23T10:00:00Z',
    ...overrides,
  }) as ProjectItem

describe('hasNoUserProjects', () => {
  it('claims nothing until the list has loaded or while more pages exist', () => {
    expect(hasNoUserProjects(null)).toBe(false)
    expect(hasNoUserProjects([], true)).toBe(false)
  })

  it('ignores the internal No project, Coach and archived projects', () => {
    expect(hasNoUserProjects([])).toBe(true)
    expect(
      hasNoUserProjects([
        project({ id: 'scratch' as ProjectId, isScratch: true }),
        project({ id: 'coach' as ProjectId, isCoach: true }),
        project({ id: 'old' as ProjectId, archivedAt: '2026-11-23T11:00:00Z' }),
      ]),
    ).toBe(true)
  })

  it('is false once a user project exists', () => {
    expect(hasNoUserProjects([project()])).toBe(false)
  })
})
