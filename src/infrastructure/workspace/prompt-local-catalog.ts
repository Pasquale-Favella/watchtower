import type { Dirent } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseSkillFrontmatter } from '@/infrastructure/agent-harnesses/skill-frontmatter.js'

export interface LocalPromptCatalogEntry {
  readonly path: string
  readonly label: string
  readonly description?: string
  readonly kind: 'skill' | 'command'
}

const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.codex/skills']
const COMMAND_ROOTS = ['.claude/commands', '.codex/prompts']
const MAX_METADATA_BYTES = 16 * 1024
const MAX_DIRECTORY_DEPTH = 32

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
}

function staysInside(root: string, path: string): boolean {
  const local = relative(root, path)
  return Boolean(local) && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

async function safeDirectory(root: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    return staysInside(root, await realpath(path))
  } catch (cause) {
    if (isMissing(cause)) return false
    throw cause
  }
}

async function safeFile(root: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    return staysInside(root, await realpath(path))
  } catch (cause) {
    if (isMissing(cause)) return false
    throw cause
  }
}

async function readMetadata(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

function metadata(content: string): { name?: string; description?: string; userInvocable?: boolean } | null {
  const parsed = parseSkillFrontmatter(content)
  if (parsed.kind === 'malformed') return null
  return parsed.kind === 'parsed' ? parsed : {}
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

async function walkDirectories(root: string, start: string): Promise<string[]> {
  const directories: string[] = []
  if (!(await safeDirectory(root, start))) return directories
  const pending = [{ path: start, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()
    if (!current) break
    directories.push(current.path)
    if (current.depth >= MAX_DIRECTORY_DEPTH) continue
    let entries: Dirent[]
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch (cause) {
      if (isMissing(cause)) continue
      throw cause
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const child = join(current.path, entry.name)
      if (await safeDirectory(root, child)) pending.push({ path: child, depth: current.depth + 1 })
    }
  }
  return directories
}

/** Finds project-local skills and prompt files without following symlinks out of the checkout. */
export async function discoverLocalPromptCatalog(root: string): Promise<LocalPromptCatalogEntry[]> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (cause) {
    if (isMissing(cause)) return []
    throw cause
  }

  const entries: LocalPromptCatalogEntry[] = []
  for (const relativeRoot of SKILL_ROOTS) {
    const skillRoot = resolve(canonicalRoot, relativeRoot)
    for (const directory of await walkDirectories(canonicalRoot, skillRoot)) {
      const file = join(directory, 'SKILL.md')
      if (!(await safeFile(canonicalRoot, file))) continue
      const details = metadata(await readMetadata(file))
      if (!details || details.userInvocable === false) continue
      const label = details.name ?? relative(canonicalRoot, directory).split(sep).at(-1) ?? basename(directory)
      entries.push({
        path: portablePath(relative(canonicalRoot, file)),
        label,
        ...(details.description ? { description: details.description } : {}),
        kind: 'skill',
      })
    }
  }

  for (const relativeRoot of COMMAND_ROOTS) {
    const commandRoot = resolve(canonicalRoot, relativeRoot)
    for (const directory of await walkDirectories(canonicalRoot, commandRoot)) {
      let children: Dirent[]
      try {
        children = await readdir(directory, { withFileTypes: true })
      } catch (cause) {
        if (isMissing(cause)) continue
        throw cause
      }
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink() || !child.name.toLowerCase().endsWith('.md')) continue
        const file = join(directory, child.name)
        if (!(await safeFile(canonicalRoot, file))) continue
        const details = metadata(await readMetadata(file))
        if (!details || details.userInvocable === false) continue
        const relativeName = relative(commandRoot, file).replace(/\.md$/i, '')
        entries.push({
          path: portablePath(relative(canonicalRoot, file)),
          label: details.name ?? portablePath(relativeName),
          ...(details.description ? { description: details.description } : {}),
          kind: 'command',
        })
      }
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path))
}
