import { describe, expect, it } from 'vitest'

import {
  resolveSidebarTaskSelection,
  sidebarTaskPresentation,
} from '@/renderer/features/workspace/delegation/sidebar-delegation.js'
import type { TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceTaskRuntimeSummary } from '@/shared/schemas/workspace-store.js'

const childId = 'child' as TaskId
const parentId = 'parent' as TaskId

function runtime(overrides: Partial<WorkspaceTaskRuntimeSummary> = {}): WorkspaceTaskRuntimeSummary {
  return { runStatus: null, pendingRequestKind: null, latestRun: null, ...overrides }
}

describe('sidebar delegation rows', () => {
  it('puts a delegated approval ahead of a delegated question and the parent Run', () => {
    const state = sidebarTaskPresentation({
      status: 'open',
      runtime: runtime({
        pendingRequestKind: 'question',
        delegatedChildren: { total: 2, active: 2, attention: 2, approvals: 1, questions: 1 },
      }),
    })
    expect(state).toEqual({ section: 'attention', label: 'Pending approval', tone: 'amber' })
  })

  it('shows a delegated question while the parent is running', () => {
    const state = sidebarTaskPresentation({
      status: 'inProgress',
      runtime: runtime({
        runStatus: 'running',
        delegatedChildren: { total: 2, active: 1, attention: 1, approvals: 0, questions: 1 },
      }),
    })
    expect(state).toEqual({ section: 'attention', label: 'Awaiting input', tone: 'indigo' })
  })

  it('shows Working when only Delegated Tasks are active', () => {
    const delegatedChildren = { total: 3, active: 2, attention: 0, approvals: 0, questions: 0 }
    expect(sidebarTaskPresentation({ status: 'blocked', runtime: runtime({ delegatedChildren }) })).toEqual({
      section: 'working',
      label: 'Working',
      tone: 'blue',
    })
    expect(
      sidebarTaskPresentation({ status: 'blocked', runtime: runtime({ delegatedChildren, runStatus: 'starting' }) }),
    ).toMatchObject({ section: 'working', label: 'Starting' })
  })

  it('keeps archived parents in Archived even when their Delegated Tasks need attention', () => {
    expect(
      sidebarTaskPresentation({
        status: 'archived',
        runtime: runtime({ delegatedChildren: { total: 1, active: 1, attention: 1, approvals: 1, questions: 0 } }),
      }),
    ).toMatchObject({ section: 'archived', label: null })
  })

  it('selects the parent row for a hidden Delegated Task and the child row when it is listed', () => {
    expect(resolveSidebarTaskSelection(childId, parentId, [{ id: parentId, status: 'open' }])).toBe(parentId)
    expect(resolveSidebarTaskSelection(childId, parentId, [{ id: parentId, status: 'archived' }])).toBe(childId)
    expect(resolveSidebarTaskSelection(childId, parentId, [{ id: childId, status: 'open' }])).toBe(childId)
    expect(resolveSidebarTaskSelection(childId, parentId, [])).toBe(childId)
    expect(resolveSidebarTaskSelection(childId, undefined, [])).toBe(childId)
  })
})
