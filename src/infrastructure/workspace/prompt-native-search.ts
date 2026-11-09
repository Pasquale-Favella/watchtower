import type { FileFinder } from '@ff-labs/fff-node'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { searchPromptPaths } from './prompt-path-search.js'

const RESULT_LIMIT = 80
const INDEX_IDLE_MS = 15 * 60 * 1000
const MAX_INDEXES = 16
type Finder = FileFinder
type Entry = {
  readonly finder: Promise<Finder | null>
  users: number
  retired: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Uses the reference composer's FFF engine, including its typo matching and filesystem watcher. */
export function createNativePromptPathSearch() {
  const indexes = new Map<string, Entry>()
  let nativeModule: Promise<typeof import('@ff-labs/fff-node') | null> | undefined

  async function create(root: string): Promise<Finder | null> {
    nativeModule ??= loadNativeModule().catch(() => null)
    const native = await nativeModule
    if (!native) return null
    const result = native.FileFinder.create({
      basePath: root,
      disableMmapCache: true,
      disableContentIndexing: true,
      aiMode: false,
      enableFsRootScanning: true,
      enableHomeDirScanning: true,
    })
    if (!result.ok) throw new Error(result.error)
    const finder = result.value
    try {
      const ready = await finder.waitForIndexReady(15_000)
      if (!ready.ok) throw new Error(ready.error)
      return finder
    } catch (cause) {
      finder.destroy()
      throw cause
    }
  }

  async function retire(root: string, entry: Entry): Promise<void> {
    if (entry.retired) return
    entry.retired = true
    if (indexes.get(root) === entry) indexes.delete(root)
    clearTimeout(entry.timer)
    if (entry.users === 0) (await entry.finder)?.destroy()
  }

  async function search(rootInput: string, query: string) {
    const root = await realpath(rootInput)
    let entry = indexes.get(root)
    if (!entry) {
      entry = { finder: create(root), users: 0, retired: false, timer: undefined }
      indexes.set(root, entry)
    }
    const owned = entry
    owned.users++
    clearTimeout(owned.timer)
    indexes.delete(root)
    indexes.set(root, owned)
    try {
      while (indexes.size > MAX_INDEXES) {
        const oldest = [...indexes.entries()].find(([, item]) => item.users === 0)
        if (!oldest) break
        await retire(...oldest)
      }
      const finder = await owned.finder
      if (!finder) return await searchPromptPaths(root, query)
      const result = finder.mixedSearch(query, { pageSize: RESULT_LIMIT + 1 })
      if (!result.ok) throw new Error(result.error)
      const rows = result.value.items.filter(item => item.item.relativePath.length > 0)
      return {
        items: rows.slice(0, RESULT_LIMIT).map(item => {
          const normalized = item.item.relativePath.replaceAll('\\', '/').replace(/\/$/, '')
          const path = item.type === 'directory' ? `${normalized}/` : normalized
          return { path, label: path, kind: 'file' as const }
        }),
        truncated: finder.isScanning() || result.value.totalMatched - (result.value.items.length - rows.length) > RESULT_LIMIT,
      }
    } catch (cause) {
      await retire(root, owned)
      throw cause
    } finally {
      owned.users--
      if (owned.retired) {
        if (owned.users === 0) (await owned.finder.catch(() => null))?.destroy()
      } else {
        owned.timer = setTimeout(() => { void retire(root, owned).catch(() => {}) }, INDEX_IDLE_MS)
        owned.timer.unref()
      }
    }
  }

  async function dispose(): Promise<void> {
    await Promise.all([...indexes].map(([root, entry]) => retire(root, entry)))
  }
  return { search, dispose }
}

async function loadNativeModule(): Promise<typeof import('@ff-labs/fff-node')> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) {
    const unpacked = join(resources, 'app.asar.unpacked', 'node_modules', '@ff-labs', 'fff-node', 'dist', 'index.js')
    if (existsSync(unpacked)) return import(pathToFileURL(unpacked).href)
  }
  return import('@ff-labs/fff-node')
}

export const nativePromptPathSearch = createNativePromptPathSearch()
