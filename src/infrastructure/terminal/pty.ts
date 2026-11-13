import { createRequire } from 'node:module'

import type * as NodePty from 'node-pty'

export interface PtyProcess {
  readonly pid: number
  readonly onData: (listener: (data: string) => void) => void
  readonly onExit: (listener: (exit: { readonly exitCode: number }) => void) => void
  readonly write: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
  /** Asks the pseudo-terminal to hang up; the host force-kills the tree when it does not exit in time. */
  readonly kill: () => void
}

export interface PtySpawnOptions {
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** Port over the native pseudo-terminal binding, so the host can run under a fake in tests. */
export interface PtySpawner {
  readonly spawn: (file: string, args: ReadonlyArray<string>, options: PtySpawnOptions) => PtyProcess
}

let nodePty: typeof NodePty | undefined

/** Loads the native binding on first use, so importing the host never touches the native module. */
function loadNodePty(): typeof NodePty {
  nodePty ??= createRequire(import.meta.url)('node-pty') as typeof NodePty
  return nodePty
}

/**
 * Windows uses ConPTY through the bundled conpty.dll: its kill path never forks a helper, which an
 * Electron main process could not run as plain Node.
 */
export const nodePtySpawner: PtySpawner = {
  spawn(file, args, options) {
    const windowsOptions = process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}
    const pty = loadNodePty().spawn(file, [...args], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...options.env },
      ...windowsOptions,
    })
    return {
      pid: pty.pid,
      onData: listener => {
        pty.onData(listener)
      },
      onExit: listener => {
        pty.onExit(({ exitCode }) => listener({ exitCode }))
      },
      write: data => {
        pty.write(data)
      },
      resize: (cols, rows) => {
        pty.resize(cols, rows)
      },
      kill: () => {
        pty.kill()
      },
    }
  },
}
