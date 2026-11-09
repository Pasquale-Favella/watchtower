import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import * as Schema from 'effect/Schema'

import { discoverLocalPromptCatalog } from '@/infrastructure/workspace/prompt-local-catalog.js'
import { nativePromptPathSearch } from '@/infrastructure/workspace/prompt-native-search.js'
import { invalidatePromptPathInventory } from '@/infrastructure/workspace/prompt-path-search.js'
import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  PROMPT_CONTEXT_SEARCH_MAX_RESULTS,
  type PromptAttachment,
  promptAttachmentSchema,
  type ResolvedPromptAttachment,
} from '@/shared/schemas/prompt-context.js'
import { insertRankedSearchResult, scorePromptCommandMatch, scorePromptSkillMatch } from '@/shared/search-ranking.js'

const exec = promisify(execFile)
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
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
    .update(
      JSON.stringify([
        value.name,
        value.size,
        value.source,
        value.mediaType,
        value.content,
        ...(value.token === undefined ? [] : [value.token]),
      ]),
    )
    .digest('hex')
}

/** Content-addressed snapshots. Replaying a command never rereads a changed source file. */
export function createPromptAttachmentStore(directory: string) {
  async function save(
    bytes: Buffer,
    name: string,
    declared: string,
    source: PromptAttachment['source'],
    token?: string,
  ): Promise<PromptAttachment> {
    if (bytes.length > PROMPT_ATTACHMENT_MAX_BYTES) throw new Error('The file exceeds 4 MiB.')
    const value = { name, size: bytes.length, source, ...(token ? { token } : {}), ...identifyContent(bytes, declared) }
    const id = digest(value)
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${id}.json`)
    await writeFile(file, JSON.stringify({ id, ...value }), { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    return { id, name, size: value.size, source, ...(value.token ? { token: value.token } : {}), mediaType: value.mediaType }
  }

  async function load(reference: PromptAttachment): Promise<ResolvedPromptAttachment> {
    const parsed = Schema.decodeUnknownSync(metadataSchema)(
      JSON.parse(await readFile(join(directory, `${reference.id}.json`), 'utf8')),
    )
    const { id, ...value } = parsed
    if (
      digest(value) !== id ||
      ['name', 'mediaType', 'source', 'size', 'token'].some(key => Reflect.get(value, key) !== Reflect.get(reference, key))
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

  return {
    import: (input: { readonly name: string; readonly mediaType: string; readonly data: string }) =>
      save(Buffer.from(input.data, 'base64'), input.name, input.mediaType, 'file'),
    resolve: (references: readonly PromptAttachment[]) => Promise.all(references.map(load)),
    async preview(reference: PromptAttachment): Promise<string | null> {
      const value = await load(reference)
      if (imageTypes.has(value.mediaType) || value.mediaType === 'application/pdf')
        return `data:${value.mediaType};base64,${value.content}`
      if (value.mediaType === 'text/plain') {
        const limit = 256 * 1024
        const text = value.content.slice(0, limit) + (value.content.length > limit ? '\n[Preview limited to 256 KiB of text.]' : '')
        return `data:text/plain;charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`
      }
      return null
    },
    async search(root: string, kind: 'file' | 'command', query: string) {
      if (kind === 'file') return nativePromptPathSearch.search(root, query)
      const needle = query.trim().toLocaleLowerCase()
      const ranked: Array<{
        item: { path: string; label: string; description?: string; kind: 'skill' | 'command' }
        score: number
        tieBreaker: string
      }> = []
      let matchCount = 0
      for (const item of await discoverLocalPromptCatalog(root)) {
        const score = item.kind === 'skill'
          ? scorePromptSkillMatch(item.label, item.description, needle)
          : scorePromptCommandMatch(item.label, item.description, needle)
        if (score === null) continue
        matchCount += 1
        insertRankedSearchResult(ranked, { item, score, tieBreaker: item.path }, PROMPT_CONTEXT_SEARCH_MAX_RESULTS)
      }
      return { items: ranked.map(result => result.item), truncated: matchCount > PROMPT_CONTEXT_SEARCH_MAX_RESULTS }
    },
    async attach(root: string, path: string, kind: 'file' | 'skill' | 'command'): Promise<PromptAttachment> {
      const localEntry =
        kind === 'file'
          ? undefined
          : (await discoverLocalPromptCatalog(root)).find(item => item.path === path && item.kind === kind)
      if (kind !== 'file' && !localEntry) throw new Error('The command is no longer available in this checkout.')
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
        invalidatePromptPathInventory(root)
        const listing = `Directory reference ${JSON.stringify(path)} in the selected checkout. Inspect files using your tools.\n${paths.slice(0, 200).join('\n')}${paths.length > 200 ? '\nListing limited to 200 files.' : ''}`
        return save(Buffer.from(listing, 'utf8'), path, 'text/plain', 'reference')
      }
      return save(
        await checkoutFile(root, path),
        path,
        '',
        kind === 'file' ? 'reference' : kind,
        localEntry ? `${kind === 'skill' ? '$' : '/'}${localEntry.label}` : undefined,
      )
    },
  }
}

export type PromptAttachmentStore = ReturnType<typeof createPromptAttachmentStore>
