import { describe, expect, it } from 'vitest'

import {
  appendUniquePage,
  compareTaskActivity,
  searchLoaded,
  taskActivityAt,
} from '@/renderer/features/workspace/project-ui.js'

describe('workspace project and task browsing helpers', () => {
  it('moves refreshed chats ahead of older activity across loaded pages without mutating the records', () => {
    const first = { id: 'a', updatedAt: '2026-11-17T10:00:00Z' }
    const second = { id: 'b', updatedAt: '2026-11-17T11:00:00Z' }
    const loaded = [first, second]
    expect([...loaded].sort(compareTaskActivity)).toEqual([second, first])
    const updated = { ...first, runtime: { lastActivityAt: '2026-11-17T12:00:00Z' } }
    expect(appendUniquePage(loaded, [updated]).sort(compareTaskActivity)).toEqual([updated, second])
    expect(loaded).toEqual([first, second])
  })

  it('uses task-wide interaction time even when attention metadata references an older Run', () => {
    const task = {
      id: 'a',
      updatedAt: '2026-11-17T10:00:00Z',
      runtime: {
        lastActivityAt: '2026-11-17T12:00:00Z',
        latestRun: { activityAt: '2026-11-17T09:00:00Z' },
      },
    }
    expect(taskActivityAt(task)).toBe('2026-11-17T12:00:00Z')
    expect(taskActivityAt({ ...task, updatedAt: '2026-11-17T13:00:00Z' })).toBe('2026-11-17T13:00:00Z')
    expect(compareTaskActivity(task, { ...task, id: 'b' })).toBeLessThan(0)
  })
  it('appends cursor pages while retaining existing rows and skipping repeated identities', () => {
    const loaded = [{ id: 'project-1', name: 'First' }]
    expect(
      appendUniquePage(loaded, [
        { id: 'project-1', name: 'Changed duplicate' },
        { id: 'project-2', name: 'Second' },
      ]),
    ).toEqual([
      { id: 'project-1', name: 'Changed duplicate' },
      { id: 'project-2', name: 'Second' },
    ])
    expect(loaded).toEqual([{ id: 'project-1', name: 'First' }])
  })

  it('searches case-insensitively within loaded records only', () => {
    const tasks = [
      { id: 'task-1', title: 'Repair sidebar' },
      { id: 'task-2', title: 'Add project list' },
    ]
    expect(searchLoaded(tasks, 'SIDEBAR', task => [task.title, task.id])).toEqual([tasks[0]])
    expect(searchLoaded(tasks.slice(0, 1), 'project list', task => [task.title])).toEqual([])
    expect(searchLoaded(tasks, '  ', task => [task.title])).toEqual(tasks)
  })
})
