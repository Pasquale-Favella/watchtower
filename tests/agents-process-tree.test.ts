import * as childProcess from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { killProcessTree, killProcessTreeSync } from '../src/infrastructure/agent-harnesses/process-tree.js'

const TASKKILL_COMMAND = 'taskkill'
const TASKKILL_ARGS = ['/pid', '4321', '/T', '/F']

describe('killProcessTree', () => {
  it('reports an unconfirmed tree when taskkill never acknowledges before the deadline', async () => {
    const run = new Proxy(childProcess.execFile, {
      apply() {
        return new childProcess.ChildProcess()
      },
    })
    const started = Date.now()
    await expect(killProcessTree(4321, 'win32', run, 30)).resolves.toEqual({
      status: 'unconfirmed',
      reason: 'deadline',
    })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('uses taskkill tree termination on win32 and reports callback errors', async () => {
    const calls: unknown[][] = []
    const run = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        const callback = args[3]
        if (typeof callback === 'function') Reflect.apply(callback, undefined, [new Error('already exited'), '', ''])
        return new childProcess.ChildProcess()
      },
    })

    await expect(killProcessTree(4321, 'win32', run)).resolves.toEqual({ status: 'unconfirmed', reason: 'failed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 3)).toEqual([
      TASKKILL_COMMAND,
      TASKKILL_ARGS,
      expect.objectContaining({ windowsHide: true, timeout: 2000 }),
    ])
    expect(calls[0]?.[3]).toEqual(expect.any(Function))
  })

  it('reports synchronous taskkill launch failure without rejecting', async () => {
    const calls: unknown[][] = []
    const run = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        throw new Error('taskkill missing')
      },
    })

    await expect(killProcessTree(4321, 'win32', run)).resolves.toEqual({ status: 'unconfirmed', reason: 'failed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 3)).toEqual([
      TASKKILL_COMMAND,
      TASKKILL_ARGS,
      expect.objectContaining({ windowsHide: true, timeout: 2000 }),
    ])
    expect(calls[0]?.[3]).toEqual(expect.any(Function))
  })

  it('does not confirm termination while the process still exists after taskkill acknowledges', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const run = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        Reflect.apply(args[3] as (...args: unknown[]) => void, undefined, [null, '', ''])
        return new childProcess.ChildProcess()
      },
    })
    try {
      await expect(killProcessTree(4321, 'win32', run, 30)).resolves.toEqual({
        status: 'unconfirmed',
        reason: 'deadline',
      })
      expect(kill).toHaveBeenCalledWith(4321, 0)
    } finally {
      kill.mockRestore()
    }
  })

  it('swallows an already-exited process on posix', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    await expect(killProcessTree(4321, 'linux')).resolves.toEqual({ status: 'confirmed' })
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')
    kill.mockRestore()
  })
})

describe('killProcessTreeSync', () => {
  it('runs taskkill /T /F synchronously and swallows its failure', () => {
    const calls: unknown[][] = []
    const run = new Proxy(childProcess.execFileSync, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        throw new Error('not found')
      },
    })
    expect(() => killProcessTreeSync(4321, run)).not.toThrow()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 2)).toEqual([TASKKILL_COMMAND, TASKKILL_ARGS])
    expect(calls[0]?.[2]).toMatchObject({ windowsHide: true })
  })
})
