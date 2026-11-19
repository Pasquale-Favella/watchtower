import { describe, expect, it } from 'vitest'

import {
  delegatedChildTotal,
  delegateSignalLabel,
  hasDelegateAttention,
  isDelegatedChild,
} from '../src/renderer/features/workspace/delegation/sidebar-delegation.js'

type Runtime = NonNullable<Parameters<typeof isDelegatedChild>[0]['runtime']>

function task(id: string, status: 'open' | 'inProgress' = 'open', runtime: Partial<Runtime> = {}) {
  return {
    id,
    title: `Task ${id}`,
    status,
    runtime: {
      runStatus: null,
      pendingRequestKind: null,
      latestRun: null,
      ...runtime,
    },
  } as unknown as Parameters<typeof isDelegatedChild>[0]
}

describe('sidebar delegation rows', () => {
  it('treats a Task with a delegatedFrom summary as a child that never shows top-level', () => {
    const child = task('child', 'open', {
      delegatedFrom: { delegationId: 'delegation-1', parentTaskId: 'parent', status: 'running' },
    } as Partial<Runtime>)
    expect(isDelegatedChild(child)).toBe(true)
    expect(isDelegatedChild(task('parent'))).toBe(false)
  })

  it('moves a parent with a waiting delegate into Needs attention, with a delegate signal', () => {
    const parent = task('parent', 'inProgress', {
      delegatedChildren: { total: 2, active: 1, attention: 1 },
    } as Partial<Runtime>)
    expect(hasDelegateAttention(parent)).toBe(true)
    expect(delegateSignalLabel(parent)).toBe('Delegate needs attention')
  })

  it('reads running delegates when nothing needs attention', () => {
    const running = task('parent', 'inProgress', {
      delegatedChildren: { total: 3, active: 2, attention: 0 },
    } as Partial<Runtime>)
    expect(hasDelegateAttention(running)).toBe(false)
    expect(delegateSignalLabel(running)).toBe('2 delegates running')
    expect(
      delegateSignalLabel(
        task('one', 'open', { delegatedChildren: { total: 1, active: 1, attention: 0 } } as Partial<Runtime>),
      ),
    ).toBe('1 delegate running')
    expect(delegateSignalLabel(task('idle'))).toBeNull()
  })

  it('reports how many children a parent can expand', () => {
    expect(delegatedChildTotal(task('none'))).toBe(0)
    expect(
      delegatedChildTotal(
        task('some', 'open', { delegatedChildren: { total: 4, active: 0, attention: 0 } } as Partial<Runtime>),
      ),
    ).toBe(4)
  })
})
