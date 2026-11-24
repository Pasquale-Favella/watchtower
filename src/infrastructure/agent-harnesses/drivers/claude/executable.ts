import { readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

import { which } from '@/infrastructure/process/executable.js'

/**
 * The Claude Agent SDK spawns the executable without a shell, so npm's Windows launcher shims
 * (`.cmd`/`.bat`/`.ps1`) cannot be used directly. The installed package ships the real binary and a
 * JavaScript entry next to the shim; both are valid `pathToClaudeCodeExecutable` targets.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.bat', '.ps1'])

const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
] as const

const isExistingFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const readShim = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** npm and pnpm launchers paste their own directory (`%dp0%` or `%~dp0`) in front of the package entry. */
const shimTarget = (shim: string, contents: string): string | undefined => {
  const relative = /%(?:dp0%|~dp0)[\\/]([^"\r\n]+)/i.exec(contents)?.[1]?.trim()
  return relative === undefined ? undefined : win32.join(win32.dirname(shim), relative)
}

/**
 * The Claude Code executable the user installed, which the SDK drives in place of its own bundled CLI.
 * Using the installed CLI is what makes the reported models match the Claude Code the user runs. Absent
 * means the SDK's bundled CLI stays in use.
 */
export function resolveInstalledClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
  commandExists: (command: string) => string | null = which,
  fileExists: (path: string) => boolean = isExistingFile,
  readCommand: (path: string) => string | undefined = readShim,
): string | undefined {
  const resolved = commandExists('claude')
  if (!resolved) return undefined
  if (platform !== 'win32') return resolved
  if (!WINDOWS_SHIM_EXTENSIONS.has(win32.extname(resolved).toLowerCase())) return resolved
  const launched = readCommand(resolved)
  const target = launched === undefined ? undefined : shimTarget(resolved, launched)
  if (target !== undefined && fileExists(target)) return target
  const shimDirectory = win32.dirname(resolved)
  for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = win32.join(shimDirectory, ...entrySegments)
    if (fileExists(candidate)) return candidate
  }
  // A shim this cannot read would only make the SDK fail to spawn, so the bundled CLI remains in use.
  return undefined
}
