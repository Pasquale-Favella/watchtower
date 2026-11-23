import { RegistryContext } from '@effect/atom-react'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { displayShortcutForAction } from '@/renderer/app/shortcuts'
import {
  shouldShowNoProjectsWelcome,
  WorkspaceNoProjectsWelcome,
} from '@/renderer/features/workspace/WorkspaceNoProjectsWelcome.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

type ProjectItem = WorkspaceProjectReadPage['items'][number]

const project = (overrides: Partial<ProjectItem> = {}): ProjectItem =>
  ({ id: 'project-1', name: 'Project', ...overrides }) as ProjectItem

describe('no projects welcome', () => {
  it('shows only once the list has loaded with no registered project', () => {
    expect(shouldShowNoProjectsWelcome(null)).toBe(false)
    expect(shouldShowNoProjectsWelcome([])).toBe(true)
  })

  it('ignores the internal No project, Coach and archived projects', () => {
    expect(
      shouldShowNoProjectsWelcome([
        project({ id: 'scratch' as ProjectId, isScratch: true }),
        project({ id: 'coach' as ProjectId, isCoach: true }),
        project({ id: 'old' as ProjectId, archivedAt: '2026-01-01T00:00:00.000Z' as never }),
      ]),
    ).toBe(true)
  })

  it('hides once any project exists or more pages may hold one', () => {
    expect(shouldShowNoProjectsWelcome([project()])).toBe(false)
    expect(shouldShowNoProjectsWelcome([project({ id: 'scratch' as ProjectId, isScratch: true }), project()])).toBe(
      false,
    )
    expect(shouldShowNoProjectsWelcome([project({ id: 'scratch' as ProjectId, isScratch: true })], true)).toBe(false)
  })

  it('offers adding a project and starting without one, each with its shortcut badge', () => {
    const registry = AtomRegistry.make()
    try {
      const markup = renderToStaticMarkup(
        createElement(
          RegistryContext.Provider,
          { value: registry },
          createElement(WorkspaceNoProjectsWelcome, { onStartWithoutProject: () => undefined }),
        ),
      )
      expect(markup).toContain('What should we work on?')
      expect(markup).toContain('Add a project, or start without one.')
      expect(markup).toContain('Add project')
      expect(markup).toContain('Start without a project')
      expect(markup).toContain(`>${displayShortcutForAction('addProject')}</kbd>`)
      expect(markup).toContain(`>${displayShortcutForAction('newChatWithoutProject')}</kbd>`)
    } finally {
      registry.dispose()
    }
  })
})
