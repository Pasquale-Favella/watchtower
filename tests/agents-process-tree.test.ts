import * as childProcess from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { killProcessTree, killProcessTreeSync } from '../src/main/agents/process-tree.js'

const TASKKILL_COMMAND = 'taskkill'
const TASKKILL_ARGS = ['/pid', '4321', '/T', '/F']

describe('killProcessTree', () => {
  it('uses taskkill tree termination on win32 and resolves callback errors', async () => {
    const calls: unknown[][] = []
    const run = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        const callback = args[3]
        if (typeof callback === 'function') Reflect.apply(callback, undefined, [new Error('already exited'), '', ''])
        return new childProcess.ChildProcess()
      },
    })

    await expect(killProcessTree(4321, 'win32', run)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 3)).toEqual([TASKKILL_COMMAND, TASKKILL_ARGS, { windowsHide: true }])
    expect(calls[0]?.[3]).toEqual(expect.any(Function))
  })

  it('swallows a synchronous throw from taskkill and still resolves (never-fails Effect)', async () => {
    const calls: unknown[][] = []
    const run = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        throw new Error('taskkill missing')
      },
    })

    await expect(killProcessTree(4321, 'win32', run)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 3)).toEqual([TASKKILL_COMMAND, TASKKILL_ARGS, { windowsHide: true }])
    expect(calls[0]?.[3]).toEqual(expect.any(Function))
  })

  it('swallows an already-exited process on posix', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    await expect(killProcessTree(4321, 'linux')).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM')
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
