import { execFile, type execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { killProcessTree, killProcessTreeSync } from '../src/main/agents/process-tree.js'

describe('killProcessTree', () => {
  it('uses taskkill tree termination on win32 and resolves callback errors', async () => {
    const run = vi.fn(((_file, _args, _options, callback) => {
      callback(new Error('already exited'), '', '')
      return undefined as never
    }) as typeof execFile)

    await expect(killProcessTree(4321, 'win32', run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], { windowsHide: true }, expect.any(Function))
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
    const run = vi.fn(() => { throw new Error('not found') }) as unknown as typeof execFileSync
    expect(() => killProcessTreeSync(4321, run)).not.toThrow()
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], expect.objectContaining({ windowsHide: true }))
  })
})