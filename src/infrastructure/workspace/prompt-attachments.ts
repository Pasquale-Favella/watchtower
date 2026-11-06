import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import * as Schema from 'effect/Schema'

import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  type PromptAttachment,
  promptAttachmentSchema,
  type ResolvedPromptAttachment,
} from '@/shared/schemas/prompt-context.js'

const exec = promisify(execFile)
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const commandRoots = ['.agents/skills', '.claude/skills', '.codex/skills', '.claude/commands', '.codex/prompts']
const metadataSchema = Schema.Struct({ ...promptAttachmentSchema.fields, content: Schema.String })

function identifyContent(bytes: Buffer, declared: string): { mediaType: string; content: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mediaType: 'image/png', content: bytes.toString('base64') }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mediaType: 'image/jpeg', content: bytes.toString('base64') }
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')))
    return { mediaType: 'image/gif', content: bytes.toString('base64') }
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return { mediaType: 'image/webp', content: bytes.toString('base64') }
  if (bytes.subarray(0, 5).toString() === '%PDF-')
    return { mediaType: 'application/pdf', content: bytes.toString('base64') }
  if (imageTypes.has(declared) || declared === 'application/pdf')
    throw new Error('The file content does not match its format.')
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!bytes.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))
      return { mediaType: 'text/plain', content }
  } catch {
    /* Non-text files stay available to the agent as immutable local files. */
  }
  return { mediaType: 'application/octet-stream', content: bytes.toString('base64') }
}

function digest(value: Omit<ResolvedPromptAttachment, 'id'>): string {
  return createHash('sha256')
    .update(JSON.stringify([value.name, value.size, value.source, value.mediaType, value.content]))
    .digest('hex')
}

/** Content-addressed snapshots. Replaying a command never rereads a changed source file. */
export function createPromptAttachmentStore(directory: string) {
  async function save(
    bytes: Buffer,
    name: string,
    declared: string,
    source: PromptAttachment['source'],
  ): Promise<PromptAttachment> {
    if (bytes.length > PROMPT_ATTACHMENT_MAX_BYTES) throw new Error('The file exceeds 4 MiB.')
    const value = { name, size: bytes.length, source, ...identifyContent(bytes, declared) }
    const id = digest(value)
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${id}.json`)
    await writeFile(file, JSON.stringify({ id, ...value }), { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    return { id, name, size: value.size, source, mediaType: value.mediaType }
  }

  async function load(reference: PromptAttachment): Promise<ResolvedPromptAttachment> {
    const parsed = Schema.decodeUnknownSync(metadataSchema)(
      JSON.parse(await readFile(join(directory, `${reference.id}.json`), 'utf8')),
    )
    const { id, ...value } = parsed
    if (
      digest(value) !== id ||
      ['name', 'mediaType', 'source', 'size'].some(key => Reflect.get(value, key) !== Reflect.get(reference, key))
    )
      throw new Error('Attachment snapshot failed integrity validation.')
    const assetDirectory = join(directory, id)
    await mkdir(assetDirectory, { recursive: true })
    const localPath = join(
      assetDirectory,
      (reference.name.split(/[\\/]/).pop() ?? 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150) ||
        'attachment',
    )
    const bytes = Buffer.from(value.content, value.mediaType === 'text/plain' ? 'utf8' : 'base64')
    await writeFile(localPath, bytes, { mode: 0o600 })
    return { ...parsed, localPath }
  }

  async function checkoutFile(root: string, path: string): Promise<Buffer> {
    const canonicalRoot = await realpath(root)
    const candidate = await realpath(resolve(canonicalRoot, path))
    const local = relative(canonicalRoot, candidate)
    if (
      isAbsolute(path) ||
      !local ||
      local === '..' ||
      local.startsWith(`..\\`) ||
      local.startsWith('../') ||
      isAbsolute(local) ||
      local.split(/[\\/]/).includes('.git')
    )
      throw new Error('File references must stay inside the selected checkout.')
    const handle = await open(candidate, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > PROMPT_ATTACHMENT_MAX_BYTES)
        throw new Error('The file exceeds the attachment limit.')
      const bytes = Buffer.alloc(Math.min(info.size + 1, PROMPT_ATTACHMENT_MAX_BYTES + 1))
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = await handle.stat()
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
        throw new Error('The file changed while it was being attached. Try again.')
      return bytes.subarray(0, length)
    } finally {
      await handle.close()
    }
  }

  async function commands(root: string) {
    const items: Array<{ path: string; label: string; kind: 'skill' | 'command' }> = []
    for (const base of commandRoots) {
      const entries = await readdir(join(root, base), { withFileTypes: true }).catch(() => [])
      for (const entry of entries.slice(0, 200)) {
        if (entry.isSymbolicLink()) continue
        const isSkill = base.endsWith('/skills')
        const path = isSkill ? `${base}/${entry.name}/SKILL.md` : `${base}/${entry.name}`
        if ((isSkill && entry.isDirectory()) || (!isSkill && entry.isFile() && entry.name.endsWith('.md'))) {
          if (
            await stat(join(root, path))
              .then(info => info.isFile())
              .catch(() => false)
          )
            items.push({ path, label: entry.name.replace(/\.md$/, ''), kind: isSkill ? 'skill' : 'command' })
        }
      }
    }
    return items
  }

  return {
    import: (input: { readonly name: string; readonly mediaType: string; readonly data: string }) =>
      save(Buffer.from(input.data, 'base64'), input.name, input.mediaType, 'file'),
    resolve: (references: readonly PromptAttachment[]) => Promise.all(references.map(load)),
    async preview(reference: PromptAttachment): Promise<string | null> {
      const value = await load(reference)
      return imageTypes.has(value.mediaType) ? `data:${value.mediaType};base64,${value.content}` : null
    },
    async search(root: string, kind: 'file' | 'command', query: string) {
      const needle = query.toLocaleLowerCase()
      let items: Array<{ path: string; label: string; kind: 'file' | 'skill' | 'command' }>
      if (kind === 'command') items = await commands(root)
      else {
        const result = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 5000,
        })
        const paths = new Set(result.stdout.split('\0').filter(Boolean))
        for (const path of [...paths]) {
          const parts = path.split('/')
          for (let index = 1; index < parts.length; index++) paths.add(`${parts.slice(0, index).join('/')}/`)
        }
        items = [...paths].map(path => ({
          path,
          label: path,
          kind: 'file' as const,
        }))
      }
      const matched = items
        .filter(item => item.label.toLocaleLowerCase().includes(needle))
        .sort((a, b) => a.label.localeCompare(b.label))
      return { items: matched.slice(0, 30), truncated: matched.length > 30 }
    },
    async attach(root: string, path: string, kind: 'file' | 'skill' | 'command'): Promise<PromptAttachment> {
      if (kind !== 'file' && !(await commands(root)).some(item => item.path === path && item.kind === kind))
        throw new Error('The command is no longer available in this checkout.')
      if (kind === 'file' && path.endsWith('/')) {
        const canonicalRoot = await realpath(root)
        const target = await realpath(resolve(root, path))
        const local = relative(canonicalRoot, target)
        if (
          isAbsolute(path) ||
          local === '..' ||
          local.startsWith('../') ||
          local.startsWith('..\\') ||
          isAbsolute(local) ||
          local.split(/[\\/]/).includes('.git') ||
          !(await stat(target)).isDirectory()
        )
          throw new Error('Folder references must stay inside the selected checkout.')
        const result = await exec(
          'git',
          ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path],
          { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 5000 },
        )
        const paths = result.stdout.split('\0').filter(Boolean)
        const listing = `Directory reference ${JSON.stringify(path)} in the selected checkout. Inspect files using your tools.\n${paths.slice(0, 200).join('\n')}${paths.length > 200 ? '\nListing limited to 200 files.' : ''}`
        return save(Buffer.from(listing, 'utf8'), path, 'text/plain', 'reference')
      }
      return save(await checkoutFile(root, path), path, '', kind === 'file' ? 'reference' : kind)
    },
  }
}

export type PromptAttachmentStore = ReturnType<typeof createPromptAttachmentStore>
