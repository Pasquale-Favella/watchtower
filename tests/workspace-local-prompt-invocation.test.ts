import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { createPromptAttachmentStore } from '@/infrastructure/workspace/prompt-attachments.js'
import { promptContextAttachmentIsReferenced } from '@/renderer/features/workspace/prompt-editor.js'

it('captures local skill aliases and nested command names with their immutable context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-local-invocations-'))
  try {
    const root = join(directory, 'repository')
    const skillPath = '.agents/skills/disk-name/SKILL.md'
    const commandPath = '.claude/commands/tools/review.md'
    await mkdir(join(root, '.agents/skills/disk-name'), { recursive: true })
    await mkdir(join(root, '.claude/commands/tools'), { recursive: true })
    await writeFile(join(root, skillPath), '---\nname: custom-review\ndescription: Review changes\n---\nCheck the tests.')
    await writeFile(join(root, commandPath), 'Review the selected tools.')
    const store = createPromptAttachmentStore(join(directory, 'assets'))
    const skill = await store.attach(root, skillPath, 'skill')
    const command = await store.attach(root, commandPath, 'command')
    expect(skill.token).toBe('$custom-review')
    expect(command.token).toBe('/tools/review')
    expect(promptContextAttachmentIsReferenced('Please use $custom-review ', skill)).toBe(true)
    expect(promptContextAttachmentIsReferenced('Please use $disk-name ', skill)).toBe(false)
    expect(promptContextAttachmentIsReferenced('/tools/review ', command)).toBe(true)
    expect(promptContextAttachmentIsReferenced('/review ', command)).toBe(false)
    expect((await store.resolve([skill]))[0]?.content).toContain('Check the tests.')
    await expect(store.resolve([{ ...skill, token: '$other' }])).rejects.toThrow('integrity')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
