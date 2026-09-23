import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { openLoginTerminal } from '../src/main/agents/login-terminal.js'

function child(): ChildProcess {
  const process = new EventEmitter() as ChildProcess
  process.unref = vi.fn(() => process)
  return process
}

describe('openLoginTerminal', () => {
  it('opens the tokenized command through cmd.exe on Windows', () => {
    const spawned = child()
    const spawn = vi.fn(() => spawned)

    expect(openLoginTerminal('codex', () => ['codex', 'login'], { platform: 'win32', spawn })).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalledWith('cmd.exe', ['/k', 'codex', 'login'], { detached: true, stdio: 'ignore', windowsHide: false })
    expect(spawned.unref).toHaveBeenCalledOnce()
  })

  it('opens Terminal with an AppleScript command on macOS', () => {
    const executed = child()
    const execFile = vi.fn(() => executed)

    expect(openLoginTerminal('claude', () => ['claude', 'auth', 'login'], { platform: 'darwin', execFile: execFile as never })).toEqual({ ok: true })
    expect(execFile).toHaveBeenCalledWith('osascript', [
      '-e', 'tell application "Terminal" to do script "claude auth login"',
      '-e', 'tell application "Terminal" to activate',
    ])
  })

  it('opens x-terminal-emulator on Linux', () => {
    const spawned = child()
    const spawn = vi.fn(() => spawned)

    expect(openLoginTerminal('goose', () => ['goose', 'configure'], { platform: 'linux', spawn })).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalledWith('x-terminal-emulator', ['-e', 'goose', 'configure'], { detached: true, stdio: 'ignore' })
    expect(spawned.unref).toHaveBeenCalledOnce()
  })

  it('returns a failure for an unknown instance or missing command', () => {
    expect(openLoginTerminal('missing', () => undefined, { platform: 'linux' })).toEqual({ ok: false, error: expect.any(String) })
    expect(openLoginTerminal('missing', () => [], { platform: 'linux' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('does not throw when a spawned terminal emits an error', () => {
    const spawned = child()
    const spawn = vi.fn(() => spawned)
    const result = openLoginTerminal('codex', () => ['codex', 'login'], { platform: 'linux', spawn })

    expect(() => spawned.emit('error', new Error('terminal unavailable'))).not.toThrow()
    expect(result).toEqual({ ok: true })
  })
})