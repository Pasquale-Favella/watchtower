import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileFinder } from '@ff-labs/fff-node'
import { expect, it } from 'vitest'

import { createNativePromptPathSearch } from '@/infrastructure/workspace/prompt-native-search.js'

it('uses the same typo-resistant ranked paths as the reference FFF engine and updates its index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchtower-fff-'))
  const search = createNativePromptPathSearch()
  let reference: FileFinder | undefined
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'WorkspacePromptInput.tsx'), '')
    await writeFile(join(root, 'src', 'WorkspaceComposer.tsx'), '')
    const created = FileFinder.create({ basePath: root, disableMmapCache: true, disableContentIndexing: true, aiMode: false, enableFsRootScanning: true, enableHomeDirScanning: true })
    if (!created.ok) throw new Error(created.error)
    reference = created.value
    await reference.waitForIndexReady(15_000)
    const query = 'WorskpacePromtInput'
    const expected = reference.mixedSearch(query, { pageSize: 81 })
    if (!expected.ok) throw new Error(expected.error)
    const result = await search.search(root, query)
    expect(result.items.map(item => item.path)).toEqual(expected.value.items.map(item => `${item.item.relativePath.replaceAll('\\', '/')}${item.type === 'directory' ? '/' : ''}`))
    expect(result.items.map(item => item.path)).toContain('src/WorkspacePromptInput.tsx')
    await writeFile(join(root, 'src', 'AddedAfterIndex.ts'), '')
    await expect.poll(async () => (await search.search(root, 'AddedAfterIndex')).items.map(item => item.path)).toContain('src/AddedAfterIndex.ts')
  } finally {
    reference?.destroy()
    await search.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
