import { existsSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'

/** Windows worker environments retain key casing and have case-sensitive property access. */
export function executablePathEnv(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return environment.PATH ?? ''
  return environment.PATH ?? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
}

/** Cross-platform PATH lookup: probe every dir with the platform's executable
 *  extensions ('' / .exe / .cmd / .bat on Windows). */
export function which(
  cmd: string,
  pathEnv: string = executablePathEnv(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dirs = pathEnv.split(pathDelimiter).filter(Boolean)
  // npm's extensionless shims are POSIX shell scripts; prefer Windows launchers.
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** npm-global CLIs on Windows are `.cmd` shims (with a POSIX-script alias)
 *  that Node's shell-less `spawn` cannot execute — spawning the bare name
 *  fails with ENOENT and an unhandled child-process error. Routing the
 *  command through `cmd.exe /c` lets the shim resolve (verified end-to-end
 *  against `opencode acp`); native `.exe` binaries spawn directly. Other
 *  platforms pass through unchanged.
 *
 *  NOTE: `cmd.exe /c` interprets the rest of the line, so args containing
 *  spaces or cmd metacharacters (`& | ^ % <>`) would be mis-parsed. All
 *  current spec args are single tokens — keep future spec args token-only. */
export function platformSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
    return { command, args: [...args] }
  }
  return { command: 'cmd.exe', args: ['/c', command, ...args] }
}
