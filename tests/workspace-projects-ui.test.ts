import { describe, expect, it } from 'vitest'

import { appendUniquePage, searchLoaded } from '@/renderer/features/workspace/project-ui.js'

describe('workspace project and task browsing helpers', () => {
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
