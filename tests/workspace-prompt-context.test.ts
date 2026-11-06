import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { createPromptAttachmentStore } from '@/infrastructure/workspace/prompt-attachments.js'
import { continuePromptList, promptTrigger } from '@/renderer/features/workspace/prompt-editor.js'
import { PROMPT_ATTACHMENT_MAX_BYTES, promptAttachmentsSchema } from '@/shared/schemas/prompt-context.js'

const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-prompt-'))
  directories.push(directory)
  const root = join(directory, 'repository')
  await mkdir(root)
  execFileSync('git', ['init', root], { windowsHide: true, stdio: 'ignore' })
  return { directory, root, store: createPromptAttachmentStore(join(directory, 'assets')) }
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('workspace prompt context', () => {
  it('captures content once and validates metadata and bytes on replay', async () => {
    const { root, store, directory } = await fixture()
    await writeFile(join(root, 'README.md'), 'Original content')
    const reference = await store.attach(root, 'README.md', 'file')
    await writeFile(join(root, 'README.md'), 'New content')
    const [resolved] = await store.resolve([reference])
    expect(resolved).toMatchObject({
      ...reference,
      content: 'Original content',
      source: 'reference',
      mediaType: 'text/plain',
    })
    expect(await readFile(resolved.localPath!, 'utf8')).toBe('Original content')
    await expect(store.resolve([{ ...reference, name: 'other.md' }])).rejects.toThrow('integrity')
    const metadata = join(directory, 'assets', `${reference.id}.json`)
    await writeFile(metadata, JSON.stringify({ ...resolved, content: 'Tampered content' }))
    await expect(store.resolve([reference])).rejects.toThrow('integrity')
  })

  it('identifies pasted images by their bytes and retains arbitrary local file attachments', async () => {
    const { store } = await fixture()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
      'base64',
    )
    const image = await store.import({ name: 'clipboard.png', mediaType: '', data: png.toString('base64') })
    expect(image.mediaType).toBe('image/png')
    expect(await store.preview(image)).toBe(`data:image/png;base64,${png.toString('base64')}`)
    const binary = await store.import({
      name: 'binary.bin',
      mediaType: 'application/octet-stream',
      data: Buffer.from([0, 255, 0]).toString('base64'),
    })
    const [resolved] = await store.resolve([binary])
    expect(await readFile(resolved.localPath!)).toEqual(Buffer.from([0, 255, 0]))
    await expect(
      store.import({ name: 'bad.png', mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') }),
    ).rejects.toThrow('format')
  })

  it('searches Git files and project skills, without following references outside the checkout', async () => {
    const { root, directory, store } = await fixture()
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'Ignored')
    await writeFile(join(root, 'visible.ts'), 'export const value = 1')
    await mkdir(join(root, '.agents', 'skills', 'review'), { recursive: true })
    await writeFile(join(root, '.agents', 'skills', 'review', 'SKILL.md'), 'Review this change carefully.')
    expect((await store.search(root, 'file', 'visible')).items).toEqual([
      { path: 'visible.ts', label: 'visible.ts', kind: 'file' },
    ])
    expect((await store.search(root, 'file', 'ignored')).items).toEqual([])
    const commands = await store.search(root, 'command', 'review')
    expect(commands.items).toEqual([{ path: '.agents/skills/review/SKILL.md', label: 'review', kind: 'skill' }])
    const skill = await store.attach(root, commands.items[0].path, 'skill')
    expect((await store.resolve([skill]))[0].content).toBe('Review this change carefully.')
    await expect(store.attach(root, 'visible.ts', 'command')).rejects.toThrow('no longer available')
    await writeFile(join(directory, 'outside.txt'), 'Outside')
    await expect(store.attach(root, '../outside.txt', 'file')).rejects.toThrow('inside')
    await expect(store.attach(root, join(directory, 'outside.txt'), 'file')).rejects.toThrow('inside')
    const outsideDirectory = join(directory, 'outside')
    await mkdir(outsideDirectory)
    await writeFile(join(outsideDirectory, 'secret.txt'), 'Outside via link')
    await symlink(outsideDirectory, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.attach(root, 'linked/secret.txt', 'file')).rejects.toThrow('inside')
  })

  it('bounds individual and aggregate attachments before a native turn can start', async () => {
    const { store } = await fixture()
    await expect(
      store.import({
        name: 'oversized',
        mediaType: '',
        data: Buffer.alloc(PROMPT_ATTACHMENT_MAX_BYTES + 1).toString('base64'),
      }),
    ).rejects.toThrow('4 MiB')
    const attachment = await store.import({
      name: 'file.txt',
      mediaType: '',
      data: Buffer.from('test').toString('base64'),
    })
    expect(Schema.is(promptAttachmentsSchema)(Array.from({ length: 9 }, () => attachment))).toBe(false)
    expect(Schema.is(promptAttachmentsSchema)([{ ...attachment, size: PROMPT_ATTACHMENT_MAX_BYTES }, attachment])).toBe(
      false,
    )
  })
})

describe('prompt editing', () => {
  it('finds context triggers at the caret without interpreting email addresses or URLs as references', () => {
    expect(promptTrigger('Read @src/fi after', 12)).toEqual({ kind: 'file', query: 'src/fi', start: 5, end: 12 })
    expect(promptTrigger('/review', 7)).toEqual({ kind: 'command', query: 'review', start: 0, end: 7 })
    expect(promptTrigger('user@example.com', 16)).toBeNull()
    expect(promptTrigger('https://example.com', 19)).toBeNull()
  })

  it('continues ordered and task lists and exits an empty list without losing the following text', () => {
    expect(continuePromptList('9. First', 8, 8)).toEqual({ value: '9. First\n10. ', caret: 13 })
    expect(continuePromptList('- [x] Done', 10, 10)).toEqual({ value: '- [x] Done\n- [ ] ', caret: 17 })
    expect(continuePromptList('Title\n- \nFooter', 8, 8)).toEqual({ value: 'Title\n\nFooter', caret: 6 })
    expect(continuePromptList('An ordinary sentence', 20, 20)).toBeNull()
  })
})
