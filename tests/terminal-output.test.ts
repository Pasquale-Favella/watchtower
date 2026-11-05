import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { bindTerminalOutput } from '@/renderer/features/workspace/terminal/terminal-output.js'

const flush = (terminal: Terminal): Promise<void> => new Promise(resolve => terminal.write('', resolve))

describe('terminal output restoration', () => {
  it('does not send device or cursor replies from replayed history back to the shell', async () => {
    const terminal = new Terminal()
    const sent: string[] = []
    const output = bindTerminalOutput(terminal, data => sent.push(data))
    try {
      output.restoreSnapshot('Saved prompt\x1b[c\x1b[6n')
      await flush(terminal)
      expect(sent).toEqual([])
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Saved prompt')

      terminal.input('echo restored\r')
      output.append('\x1b[c\x1b[6n')
      await flush(terminal)
      expect(sent).toEqual(['echo restored\r', '\x1b[?1;2c', '\x1b[1;13R'])
    } finally {
      output.dispose()
      terminal.dispose()
    }
  })

  it('keeps replies muted through overlapping snapshots and resumes them for live output', async () => {
    const terminal = new Terminal()
    const sent: string[] = []
    const output = bindTerminalOutput(terminal, data => sent.push(data))
    try {
      output.restoreSnapshot('\x1b[c')
      output.restoreSnapshot('\x1b[c')
      output.append('\x1b[c')
      await flush(terminal)
      expect(sent).toEqual(['\x1b[?1;2c'])
      output.dispose()
      terminal.input('detached')
      expect(sent).toEqual(['\x1b[?1;2c'])
    } finally {
      output.dispose()
      terminal.dispose()
    }
  })

  it('preserves keyboard and pasted input while saved output is still being parsed', async () => {
    const terminal = new Terminal()
    const sent: string[] = []
    const output = bindTerminalOutput(terminal, data => sent.push(data))
    try {
      output.restoreSnapshot('Saved output\x1b[c\x1b[>c\x1b[?6n')
      terminal.input('typed command')
      terminal.input('\x1b[D')
      await flush(terminal)
      expect(sent).toEqual(['typed command', '\x1b[D'])
      output.append('\x1b[>c\x1b[?6n')
      await flush(terminal)
      expect(sent.slice(2)).toEqual(['\x1b[>0;276;0c', '\x1b[?1;13R'])
    } finally {
      output.dispose()
      terminal.dispose()
    }
  })
})
