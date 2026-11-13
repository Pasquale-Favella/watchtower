import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { discoverLocalPromptCatalog } from '@/infrastructure/workspace/prompt-local-catalog.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-prompt-catalog-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('local prompt catalog', () => {
  it('finds nested skills and commands with frontmatter metadata', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, '.agents', 'skills', 'group', 'review'), { recursive: true })
    await mkdir(join(root, '.claude', 'commands', 'git'), { recursive: true })
    await mkdir(join(root, '.codex', 'prompts'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'skills', 'group', 'review', 'SKILL.md'),
      '---\nname: Code review\ndescription: Check the current changes\n---\nBody',
    )
    await writeFile(
      join(root, '.claude', 'commands', 'git', 'status.md'),
      '---\nname: git status\ndescription: Summarize repository status\n---\nBody',
    )
    await writeFile(join(root, '.codex', 'prompts', 'explain.md'), 'Explain this code')

    const entries = await discoverLocalPromptCatalog(root)
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: '.codex/prompts/explain.md', label: 'explain', kind: 'command' },
        {
          path: '.claude/commands/git/status.md',
          label: 'git status',
          description: 'Summarize repository status',
          kind: 'command',
        },
        {
          path: '.agents/skills/group/review/SKILL.md',
          label: 'Code review',
          description: 'Check the current changes',
          kind: 'skill',
        },
      ]),
    )
  })

  it('omits skills marked user-invocable false and does not cap candidates before matching', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, '.claude', 'skills', 'internal'), { recursive: true })
    await writeFile(
      join(root, '.claude', 'skills', 'internal', 'SKILL.md'),
      '---\nname: internal\nuser-invocable: false\n---\nBody',
    )
    await mkdir(join(root, '.claude', 'commands'), { recursive: true })
    await Promise.all(
      Array.from({ length: 225 }, (_, index) =>
        writeFile(join(root, '.claude', 'commands', `command-${String(index).padStart(3, '0')}.md`), 'Body'),
      ),
    )

    const entries = await discoverLocalPromptCatalog(root)
    expect(entries).toHaveLength(225)
    expect(entries.find(entry => entry.label === 'command-224')).toMatchObject({
      path: '.claude/commands/command-224.md',
      kind: 'command',
    })
    expect(entries.some(entry => entry.label === 'internal')).toBe(false)
  })

  it('ignores prompt roots that are symlinks outside the checkout', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await mkdir(join(outside, 'commands'), { recursive: true })
    await writeFile(join(outside, 'commands', 'secret.md'), '---\nname: secret\n---')
    await mkdir(join(root, '.claude'), { recursive: true })
    try {
      await symlink(join(outside, 'commands'), join(root, '.claude', 'commands'), 'junction')
    } catch {
      return
    }

    expect(await discoverLocalPromptCatalog(root)).toEqual([])
  })
})
