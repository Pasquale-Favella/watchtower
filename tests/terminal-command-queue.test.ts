import { describe, expect, it } from 'vitest'

import {
  queuedTerminalCommands,
  queueTerminalCommand,
  subscribeTerminalCommands,
  takeTerminalCommand,
} from '@/renderer/features/workspace/terminal/terminal-command-queue.js'

describe('terminal command queue', () => {
  it('holds shell commands per owner in the order they were queued', () => {
    const owner = `task:${crypto.randomUUID()}`
    queueTerminalCommand(owner, 'pnpm test')
    queueTerminalCommand(owner, 'git status')
    expect(queuedTerminalCommands(owner)).toEqual(['pnpm test', 'git status'])
    takeTerminalCommand(owner)
    expect(queuedTerminalCommands(owner)).toEqual(['git status'])
    takeTerminalCommand(owner)
    expect(queuedTerminalCommands(owner)).toEqual([])
  })

  it('keeps one owner queue out of another owner', () => {
    const first = `task:${crypto.randomUUID()}`
    const second = `task:${crypto.randomUUID()}`
    queueTerminalCommand(first, 'ls')
    expect(queuedTerminalCommands(second)).toEqual([])
    takeTerminalCommand(first)
  })

  it('notifies subscribers on queue and take, and stops after unsubscribe', () => {
    const owner = `task:${crypto.randomUUID()}`
    let notified = 0
    const unsubscribe = subscribeTerminalCommands(() => {
      notified += 1
    })
    queueTerminalCommand(owner, 'npm run build')
    takeTerminalCommand(owner)
    expect(notified).toBe(2)
    unsubscribe()
    queueTerminalCommand(owner, 'npm run lint')
    takeTerminalCommand(owner)
    expect(notified).toBe(2)
  })

  it('returns a stable snapshot until the queue changes', () => {
    const owner = `task:${crypto.randomUUID()}`
    const before = queuedTerminalCommands(owner)
    expect(queuedTerminalCommands(owner)).toBe(before)
    queueTerminalCommand(owner, 'echo hi')
    expect(queuedTerminalCommands(owner)).not.toBe(before)
    takeTerminalCommand(owner)
  })
})
