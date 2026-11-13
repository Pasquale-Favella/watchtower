import type { Terminal } from '@xterm/xterm'

interface TerminalOutput {
  restoreSnapshot(data: string): void
  append(data: string): void
  dispose(): void
}

/** Saved device/status queries must not be answered again when the terminal is restored. */
export function bindTerminalOutput(
  terminal: Pick<Terminal, 'onData' | 'parser' | 'reset' | 'write'>,
  onInput: (data: string) => void,
): TerminalOutput {
  let pendingSnapshots = 0
  const input = terminal.onData(onInput)
  const queries = [{ final: 'c' }, { prefix: '>', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' }].map(
    query => terminal.parser.registerCsiHandler(query, () => pendingSnapshots > 0),
  )

  return {
    restoreSnapshot(data: string): void {
      pendingSnapshots += 1
      terminal.reset()
      // xterm parses writes asynchronously. Keep replies muted until this write is parsed,
      // including when another snapshot has already been queued by a reconnect.
      terminal.write(data, () => {
        pendingSnapshots -= 1
      })
    },
    append(data: string): void {
      terminal.write(data)
    },
    dispose(): void {
      input.dispose()
      for (const query of queries) query.dispose()
    },
  }
}
