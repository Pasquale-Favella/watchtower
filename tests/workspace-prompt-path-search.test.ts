import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { invalidatePromptPathInventory, searchPromptPaths } from '@/infrastructure/workspace/prompt-path-search.js'

const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-prompt-paths-'))
  directories.push(directory)
  execFileSync('git', ['init', directory], { windowsHide: true, stdio: 'ignore' })
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    invalidatePromptPathInventory(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

describe('workspace prompt path search', () => {
  it('ranks an exact path ahead of alphabetical results beyond the 80 item cap', async () => {
    const root = await fixture()
    for (let index = 0; index < 100; index += 1) {
      const path = join(root, `target-query-${String(index).padStart(3, '0')}.txt`)
      await writeFile(path, '')
    }
    await writeFile(join(root, 'target-query'), '')

    const result = await searchPromptPaths(root, 'target-query')

    expect(result.items).toHaveLength(80)
    expect(result.items[0]?.path).toBe('target-query')
    expect(result.truncated).toBe(true)
  })

  it('matches fuzzy paths and includes directory references', async () => {
    const root = await fixture()
    await mkdir(join(root, 'src', 'workspace'), { recursive: true })
    await writeFile(join(root, 'src', 'workspace', 'PromptInput.tsx'), '')

    const fuzzy = await searchPromptPaths(root, 'prmptinput')
    const folders = await searchPromptPaths(root, 'src')

    expect(fuzzy.items.map(item => item.path)).toContain('src/workspace/PromptInput.tsx')
    expect(folders.items.map(item => item.path)).toContain('src/')
    expect(folders.items.map(item => item.path)).toContain('src/workspace/')
  })

  it('refreshes the cached inventory after nested file additions and removals', async () => {
    const root = await fixture()
    const nested = join(root, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'before.txt'), '')
    expect((await searchPromptPaths(root, 'before')).items.map(item => item.path)).toContain('nested/before.txt')

    await writeFile(join(nested, 'after.txt'), '')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await searchPromptPaths(root, 'after')).items.map(item => item.path)).toContain('nested/after.txt')

    await rm(join(nested, 'before.txt'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await searchPromptPaths(root, 'before')).items).toEqual([])
  })

  it('ignores Git excluded paths', async () => {
    const root = await fixture()
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), '')
    await writeFile(join(root, 'visible.txt'), '')

    expect((await searchPromptPaths(root, 'txt')).items.map(item => item.path)).toContain('visible.txt')
    expect((await searchPromptPaths(root, 'ignored')).items).toEqual([])
  })
})
