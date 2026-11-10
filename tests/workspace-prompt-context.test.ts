import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { createPromptAttachmentStore } from '@/infrastructure/workspace/prompt-attachments.js'
import {
  attachmentPromptToken,
  commandPromptToken,
  continuePromptList,
  filePromptToken,
  isPathWord,
  limitPromptEdit,
  promptContextAttachmentIsReferenced,
  promptPasteUsesAttachment,
  promptTrigger,
  skillPromptToken,
  visiblePromptAttachments,
} from '@/renderer/features/workspace/prompt-editor.js'
import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  type PromptAttachment,
  promptAttachmentsSchema,
} from '@/shared/schemas/prompt-context.js'

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
  it('returns nested local skills with bounded descriptions while searching their full metadata', async () => {
    const { root, store } = await fixture()
    const skillDirectory = join(root, '.agents', 'skills', 'group', 'nested', 'review')
    await mkdir(skillDirectory, { recursive: true })
    const description = 'Review changes '.repeat(60) + 'unique-search-term'
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      `---\nname: nested-review\ndescription: ${description}\n---\nInstructions`,
    )
    const result = await store.search(root, 'command', 'unique-search-term')
    expect(result.items).toEqual([
      {
        path: '.agents/skills/group/nested/review/SKILL.md',
        label: 'nested-review',
        kind: 'skill',
        description: description.slice(0, 512),
      },
    ])
  })

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
    expect((await store.search(root, 'file', 'visible')).items[0]).toEqual({
      path: 'visible.ts',
      label: 'visible.ts',
      kind: 'file',
    })
    expect((await store.search(root, 'file', 'ignored')).items.map(item => item.path)).not.toContain('ignored.txt')
    const commands = await store.search(root, 'command', 'review')
    expect(commands.items).toEqual([{ path: '.agents/skills/review/SKILL.md', label: 'review', kind: 'skill' }])
    const skill = await store.attach(root, commands.items[0].path, 'skill')
    expect(skill.token).toBe('$review')
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

  it('returns all matching local skills for the ACP fallback menu', async () => {
    const { root, store } = await fixture()
    const skillsRoot = join(root, '.agents', 'skills')
    for (let index = 0; index < 40; index += 1) {
      const name = `skill-${index}`
      const path = join(skillsRoot, name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'SKILL.md'), `Instructions for ${name}.`)
    }

    const result = await store.search(root, 'command', '')

    expect(result.items).toHaveLength(40)
    expect(result.truncated).toBe(false)
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
  it('finds @ file, / command and $ skill triggers at the caret, without interpreting money, paths or URLs as references', () => {
    expect(promptTrigger('Read @src/fi after', 12)).toEqual({ kind: 'file', query: 'src/fi', start: 5, end: 12 })
    expect(promptTrigger('/review', 7)).toEqual({ kind: 'command', query: 'review', start: 0, end: 7 })
    expect(promptTrigger('/model opus', 11)).toEqual({
      kind: 'command',
      query: 'model',
      start: 0,
      end: 11,
      modelQuery: 'opus',
    })
    expect(promptTrigger('Review #42 now', 10)).toEqual({ kind: 'pullRequest', query: '42', start: 7, end: 10 })
    expect(promptTrigger('try $review now', 11)).toEqual({ kind: 'skill', query: 'review', start: 4, end: 11 })
    expect(promptTrigger('$', 1)).toEqual({ kind: 'skill', query: '', start: 0, end: 1 })
    expect(promptTrigger('try €review now', 'try €review'.length)).toEqual({
      kind: 'skill',
      query: 'review',
      start: 'try '.length,
      end: 'try €review'.length,
    })
    expect(promptTrigger('user@example.com', 16)).toBeNull()
    expect(promptTrigger('https://example.com', 19)).toBeNull()
    expect(promptTrigger('/src/foo', 8)).toBeNull()
    expect(promptTrigger('I paid $5 and', 9)).toBeNull()
    expect(promptTrigger('worth $10k. later', 11)).toBeNull()
    expect(promptTrigger('set $3,50 aside', 9)).toBeNull()
    expect(promptTrigger('€9.99', '€9.99'.length)).toBeNull()
    expect(promptTrigger('line\n/read this', 9)).toEqual({ kind: 'command', query: 'rea', start: 5, end: 9 })
    // The second slash is scanned past the caret, so a half-typed path never opens the command menu.
    expect(isPathWord('/runs/12', 0, 5)).toBe(true)
    expect(isPathWord('/runs and more', 0, 5)).toBe(false)
    expect(promptTrigger('note $a/b', 9)).toEqual({ kind: 'skill', query: 'a/b', start: 5, end: 9 })
    expect(skillPromptToken('.agents/skills/review/SKILL.md')).toBe('$review ')
    expect(skillPromptToken('.agents\\skills\\repair\\SKILL.md')).toBe('$repair ')
    expect(filePromptToken('README.md')).toBe('[README.md](README.md) ')
    expect(filePromptToken('new name with spaces/a (1).md')).toBe(
      '[a (1).md](new%20name%20with%20spaces/a%20%281%29.md) ',
    )
    expect(filePromptToken('src/lib/')).toBe('[lib/](src/lib/) ')
  })

  it('keeps selected skills and commands inline and removes their context when their token is deleted', () => {
    const skill: PromptAttachment = {
      id: 'a'.repeat(64),
      name: '.agents/skills/review/SKILL.md',
      mediaType: 'text/plain',
      size: 0,
      source: 'skill',
    }
    const command: PromptAttachment = {
      id: 'b'.repeat(64),
      name: '.claude/commands/review.md',
      mediaType: 'text/plain',
      size: 0,
      source: 'command',
    }
    const file: PromptAttachment = {
      id: 'c'.repeat(64),
      name: 'notes.txt',
      mediaType: 'text/plain',
      size: 0,
      source: 'file',
    }
    const image: PromptAttachment = {
      id: 'e'.repeat(64),
      name: 'photo.png',
      mediaType: 'image/png',
      size: 10,
      source: 'file',
    }
    const reference: PromptAttachment = {
      id: 'd'.repeat(64),
      name: 'README.md',
      mediaType: 'text/plain',
      size: 0,
      source: 'reference',
    }

    expect(commandPromptToken(command.name)).toBe('/review ')
    expect(commandPromptToken('.agents/commands/tools/review.md')).toBe('/tools/review ')
    expect(promptContextAttachmentIsReferenced('[README.md](README.md) ', reference)).toBe(true)
    expect(promptContextAttachmentIsReferenced('[README.md](README.md)', reference)).toBe(true)
    expect(promptContextAttachmentIsReferenced('README.md', reference)).toBe(false)
    expect(promptContextAttachmentIsReferenced('$review ', skill)).toBe(true)
    expect(promptContextAttachmentIsReferenced('$review', skill)).toBe(true)
    expect(promptContextAttachmentIsReferenced('$custom-review ', { ...skill, token: '$custom-review' })).toBe(true)
    expect(promptContextAttachmentIsReferenced('review this', skill)).toBe(false)
    expect(promptContextAttachmentIsReferenced('/review this', command)).toBe(true)
    expect(
      promptContextAttachmentIsReferenced('/tools/review this', {
        ...command,
        token: '/tools/review',
      }),
    ).toBe(true)
    expect(attachmentPromptToken(file)).toBe(`[notes.txt](attachment:${file.id}) `)
    expect(promptContextAttachmentIsReferenced(attachmentPromptToken(file), file)).toBe(true)
    expect(promptContextAttachmentIsReferenced('Review it', file)).toBe(false)
    expect(promptContextAttachmentIsReferenced('Review it', image)).toBe(true)
    expect(promptContextAttachmentIsReferenced('review this', command)).toBe(false)
    expect(visiblePromptAttachments([skill, command, file, image, reference])).toEqual([image])
  })

  it('continues ordered and task lists and exits an empty list without losing the following text', () => {
    expect(continuePromptList('9. First', 8, 8)).toEqual({ value: '9. First\n10. ', caret: 13 })
    expect(continuePromptList('- [x] Done', 10, 10)).toEqual({ value: '- [x] Done\n- [ ] ', caret: 17 })
    expect(continuePromptList('Title\n- \nFooter', 8, 8)).toEqual({ value: 'Title\n\nFooter', caret: 6 })
    expect(continuePromptList('An ordinary sentence', 20, 20)).toBeNull()
  })

  it('limits inserted prompt text while preserving the surrounding selection', () => {
    expect(limitPromptEdit('abcdef', 'abWXYZef', 6, 6)).toEqual({ value: 'abWXef', cursor: 4 })
    expect(limitPromptEdit('hello', 'hello!', 6, 5)).toEqual({ value: 'hello', cursor: 5 })
    expect(limitPromptEdit('hello', 'hello', 5, 5)).toEqual({ value: 'hello', cursor: 5 })
  })

  it('attaches large or over-limit pastes unless the user requests editable text', () => {
    expect(promptPasteUsesAttachment('', 'x'.repeat(32 * 1024), 0, 0, 200_000)).toBe(true)
    expect(promptPasteUsesAttachment('abc', 'xy', 1, 2, 4)).toBe(false)
    expect(promptPasteUsesAttachment('abc', 'xy', 1, 2, 4, true)).toBe(false)
    expect(promptPasteUsesAttachment('abc', 'xyz', 1, 2, 3)).toBe(true)
  })
})
