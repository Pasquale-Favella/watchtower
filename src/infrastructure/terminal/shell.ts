import { posix, win32 } from 'node:path'

import type { TerminalEnvironmentSource } from '@/infrastructure/terminal/environment.js'

export interface TerminalShellCommand {
  readonly file: string
  readonly args: ReadonlyArray<string>
}

export interface TerminalShellSource {
  readonly platform: NodeJS.Platform
  readonly env: TerminalEnvironmentSource
  readonly exists: (file: string) => boolean
}

/** Reads an environment variable by name, matching Windows' case-insensitive names. */
function variable(env: TerminalEnvironmentSource, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase())
  const value = key === undefined ? undefined : env[key]
  return value?.trim() ? value : undefined
}

function onPath(env: TerminalEnvironmentSource, name: string, exists: (file: string) => boolean): string | undefined {
  for (const directory of (variable(env, 'PATH') ?? '').split(';')) {
    if (!directory) continue
    const candidate = win32.join(directory, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Windows: pwsh.exe, then Windows PowerShell, then ComSpec; PowerShell starts without its banner.
 * POSIX: the login shell from SHELL, then /bin/bash, then /bin/sh, each started as a login shell.
 */
export function resolveTerminalShell(source: TerminalShellSource): TerminalShellCommand {
  if (source.platform === 'win32') {
    const pwsh = onPath(source.env, 'pwsh.exe', source.exists)
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] }
    const systemRoot = variable(source.env, 'SystemRoot') ?? 'C:\\Windows'
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (source.exists(powershell)) return { file: powershell, args: ['-NoLogo'] }
    return { file: variable(source.env, 'ComSpec') ?? 'cmd.exe', args: [] }
  }
  const login = variable(source.env, 'SHELL')
  const candidates = [login, '/bin/bash', '/bin/sh'].filter((file): file is string => file !== undefined)
  const file = candidates.find(candidate => posix.isAbsolute(candidate) && source.exists(candidate)) ?? '/bin/sh'
  return { file, args: ['-l'] }
}
