import { spawn } from 'node:child_process'

import type { ProbeSpawn } from '../src/infrastructure/agent-harnesses/probe.js'
import { killProcessTree } from '../src/infrastructure/agent-harnesses/process-tree.js'

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

export function probeProcessTree() {
  let rootPid: number | undefined
  let grandchildPid: number | undefined
  let spawned: ((pid: number) => void) | undefined
  const ready = new Promise<number>(resolve => {
    spawned = resolve
  })
  const spawnTree: ProbeSpawn = (_command, _args, options) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)' ], {
        stdio: 'ignore', windowsHide: true,
      });
      console.log(child.pid);
      setTimeout(() => process.exit(0), 10000);
    `,
      ],
      { ...options, cwd: process.cwd() },
    )
    rootPid = child.pid
    let output = ''
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.includes('\n') && grandchildPid === undefined) {
        grandchildPid = Number(output.trim())
        spawned?.(grandchildPid)
      }
    })
    return child
  }
  return {
    ready,
    spawn: spawnTree,
    dispose: async () => {
      if (rootPid !== undefined && processIsRunning(rootPid)) await killProcessTree(rootPid)
      if (grandchildPid !== undefined && processIsRunning(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    },
  }
}
