import { execFile } from 'node:child_process'
import { type FSWatcher,watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import { insertRankedSearchResult, scoreQueryMatch } from '@/shared/search-ranking.js'

const exec = promisify(execFile)
const MAX_RESULTS = 80
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHES = 16
const MAX_CACHE_BYTES = 64 * 1024 * 1024

type Inventory = { paths: string[]; truncated: boolean; expiresAt: number; freshness: string; bytes: number }
type RankedPath = { path: string; label: string; kind: 'file' }

const inventories = new Map<string, Inventory>()
const pending = new Map<string, Promise<Inventory>>()
const watchers = new Map<string, FSWatcher>()
const generations = new Map<string, number>()
let retainedBytes = 0

async function freshness(root: string): Promise<string> {
  const values = await Promise.all(['.git/index', '.'].map(path =>
    stat(`${root}/${path}`).then(info => `${info.mtimeMs}:${info.size}`).catch(() => 'missing'),
  ))
  return values.join('|')
}

async function loadInventory(root: string): Promise<Inventory> {
  const key = root
  const currentFreshness = await freshness(root)
  const cached = inventories.get(key)
  if (cached && cached.expiresAt > Date.now() && cached.freshness === currentFreshness) return cached
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  watchCheckout(root)
  const loading = (async () => {
    while (true) {
      watchCheckout(root)
      const generation = generations.get(key) ?? 0
      const result = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5000,
      })
      if (generation !== (generations.get(key) ?? 0)) continue
      const paths = new Set(result.stdout.split('\0').filter(Boolean))
      for (const path of [...paths]) {
        const parts = path.split('/')
        for (let index = 1; index < parts.length; index += 1) paths.add(`${parts.slice(0, index).join('/')}/`)
      }
      const allPaths = [...paths]
      const bytes = allPaths.reduce((total, path) => total + path.length * 2 + 24, 0)
      const currentFreshness = await freshness(root)
      if (generation !== (generations.get(key) ?? 0)) continue
      const inventory = {
        paths: allPaths,
        truncated: false,
        expiresAt: Date.now() + (watchers.has(root) ? CACHE_TTL_MS : 1000),
        freshness: currentFreshness,
        bytes,
      }
      if (bytes > MAX_CACHE_BYTES) {
        watchers.get(root)?.close()
        watchers.delete(root)
        return inventory
      }
      const replaced = inventories.get(key)
      if (replaced) retainedBytes -= replaced.bytes
      inventories.delete(key)
      retainedBytes += inventory.bytes
      inventories.set(key, inventory)
      while (inventories.size > MAX_CACHES || retainedBytes > MAX_CACHE_BYTES) {
        const oldest = inventories.keys().next().value
        if (oldest === undefined) break
        const removed = inventories.get(oldest)
        inventories.delete(oldest)
        retainedBytes -= removed?.bytes ?? 0
        watchers.get(oldest)?.close()
        watchers.delete(oldest)
      }
      return inventory
    }
  })().finally(() => {
    pending.delete(key)
    generations.delete(key)
  })
  pending.set(key, loading)
  return loading
}

export function invalidatePromptPathInventory(root: string): void {
  const removed = inventories.get(root)
  if (removed) retainedBytes -= removed.bytes
  inventories.delete(root)
  if (pending.has(root)) generations.set(root, (generations.get(root) ?? 0) + 1)
  watchers.get(root)?.close()
  watchers.delete(root)
}

function watchCheckout(root: string): boolean {
  if (watchers.has(root)) return true
  try {
    const watcher = watch(root, { recursive: true }, () => invalidatePromptPathInventory(root))
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(root)
      invalidatePromptPathInventory(root)
    })
    watcher.unref()
    watchers.set(root, watcher)
    return true
  } catch {
    return false
  }
}

export async function searchPromptPaths(root: string, query: string): Promise<{
  items: RankedPath[]
  truncated: boolean
}> {
  const inventory = await loadInventory(root)
  const normalized = query.trim().toLocaleLowerCase()
  const ranked: Array<{ item: RankedPath; score: number; tieBreaker: string }> = []
  let matchCount = 0
  for (const path of inventory.paths) {
    const score = normalized
      ? scoreQueryMatch({
          value: path.toLocaleLowerCase(),
          query: normalized,
          exactBase: 0,
          prefixBase: 2,
          boundaryBase: 4,
          includesBase: 6,
          fuzzyBase: 100,
          boundaryMarkers: ['/', '-', '_', '.', ' '],
        })
      : 0
    if (score === null) continue
    matchCount += 1
    const depthPenalty = path.split('/').length * 2
    const item = { path, label: path, kind: 'file' as const }
    insertRankedSearchResult(ranked, { item, score: score + depthPenalty, tieBreaker: path }, MAX_RESULTS)
  }
  return { items: ranked.map(result => result.item), truncated: inventory.truncated || matchCount > MAX_RESULTS }
}
