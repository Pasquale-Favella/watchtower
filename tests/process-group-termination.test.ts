import { describe, expect, it, vi } from 'vitest'

import {
  killProcessTreeSync,
  type ProcessGroupSignals,
  terminateProcessGroup,
} from '../src/infrastructure/agent-harnesses/process-tree.js'

/** A fake OS: the group stays alive until it receives `dieOn`, and time advances only through sleep. */
function fakeGroup(dieOn: NodeJS.Signals | 'never') {
  const calls: Array<{ target: number; signal: NodeJS.Signals }> = []
  let alive = true
  let clock = 0
  const signals: ProcessGroupSignals = {
    kill: (target, signal) => {
      calls.push({ target, signal })
      if (dieOn === signal) alive = false
    },
    isAlive: () => alive,
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
  }
  return { signals, calls }
}

describe('terminateProcessGroup', () => {
  it('sends SIGTERM to the whole group and never escalates when the group exits within the grace period', async () => {
    const group = fakeGroup('SIGTERM')

    await expect(terminateProcessGroup(4321, 500, group.signals)).resolves.toEqual({ status: 'confirmed' })

    expect(group.calls).toEqual([{ target: -4321, signal: 'SIGTERM' }])
  })

  it('escalates to SIGKILL on the group after the grace period when SIGTERM is ignored', async () => {
    const group = fakeGroup('SIGKILL')

    await expect(terminateProcessGroup(4321, 500, group.signals)).resolves.toEqual({ status: 'confirmed' })

    expect(group.calls).toEqual([
      { target: -4321, signal: 'SIGTERM' },
      { target: -4321, signal: 'SIGKILL' },
    ])
  })

  it('reports the group unconfirmed when it survives SIGKILL past the teardown deadline', async () => {
    const group = fakeGroup('never')

    await expect(terminateProcessGroup(4321, 100, group.signals)).resolves.toEqual({
      status: 'unconfirmed',
      reason: 'deadline',
    })
    expect(group.calls.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('treats a group that is already gone as confirmed without signalling again', async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    await expect(
      terminateProcessGroup(4321, 100, {
        kill,
        isAlive: () => false,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ status: 'confirmed' })
    expect(kill).toHaveBeenCalledTimes(1)
  })
})

describe('killProcessTreeSync on POSIX', () => {
  it('kills the process group the root leads, not the root alone', () => {
    const kill = vi.fn()
    const run = vi.fn()

    killProcessTreeSync(4321, run as never, 'linux', kill)

    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')
    expect(kill).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to the root when no group leads with that id', () => {
    const kill = vi.fn((target: number) => {
      if (target < 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    killProcessTreeSync(4321, vi.fn() as never, 'darwin', kill)

    expect(kill.mock.calls).toEqual([
      [-4321, 'SIGKILL'],
      [4321, 'SIGKILL'],
    ])
  })
})
