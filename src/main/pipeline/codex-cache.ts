import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'

import { resolveCacheDir } from '../env.js'
import type { ParsedProviderCall } from './providers/types.js'
import { isScanAbortedError, throwIfScanAborted } from './scan-control.js'

// v4: attribute MCP calls emitted as event_msg/mcp_tool_call_end (issue #478).
// Recent Codex sessions cached under v3 dropped these, so force a re-parse.
// v5: also attribute CLI-wrapped MCP calls (`mcp-cli call server tool`) that
// Codex logs as a plain exec_command (issue #478 follow-up). Force a re-parse
// so sessions cached under v4 pick up the CLI-MCP attribution.
// v6: rich-session-capture — per-call locAdded/locRemoved/editFailed from
// patch_apply_end. Sessions cached under v5 lack these fields; re-parse to add.
// v8: PR evidence — bounded `assistantText` on calls whose assistant message
// referenced a PR (e.g. the agent printing the URL it just created). Sessions
// cached under v7 lack the field; re-parse to add.
const CODEX_CACHE_VERSION = 8
const CACHE_FILE = 'codex-results.json'

type FileFingerprint = { mtimeMs: number; sizeBytes: number }

type FileEntry = {
  mtimeMs: number
  sizeBytes: number
  project: string
  calls: ParsedProviderCall[]
}

type ResultCache = {
  version: number
  files: Record<string, FileEntry>
}

function getCacheDir(): string {
  return resolveCacheDir()
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

let memCache: ResultCache | null = null

async function loadCache(signal?: AbortSignal): Promise<ResultCache> {
  throwIfScanAborted(signal)
  if (memCache) return memCache
  try {
    const raw = await readFile(getCachePath(), { encoding: 'utf-8', ...(signal ? { signal } : {}) })
    throwIfScanAborted(signal)
    const cache = JSON.parse(raw) as ResultCache
    if (cache.version === CODEX_CACHE_VERSION && cache.files && typeof cache.files === 'object') {
      throwIfScanAborted(signal)
      memCache = cache
      return cache
    }
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
  }
  throwIfScanAborted(signal)
  memCache = { version: CODEX_CACHE_VERSION, files: {} }
  return memCache
}

function getEntry(cache: ResultCache, filePath: string, fp: FileFingerprint): FileEntry | null {
  if (!Object.hasOwn(cache.files, filePath)) return null
  const entry = cache.files[filePath]
  if (entry && entry.mtimeMs === fp.mtimeMs && entry.sizeBytes === fp.sizeBytes) {
    return entry
  }
  return null
}

export async function readCachedCodexResults(
  filePath: string,
  signal?: AbortSignal,
): Promise<ParsedProviderCall[] | null> {
  throwIfScanAborted(signal)
  try {
    const s = await stat(filePath)
    throwIfScanAborted(signal)
    const cache = await loadCache(signal)
    throwIfScanAborted(signal)
    const entry = getEntry(cache, filePath, { mtimeMs: s.mtimeMs, sizeBytes: s.size })
    return entry?.calls ?? null
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
  }
  throwIfScanAborted(signal)
  return null
}

export async function getCachedCodexProject(filePath: string, signal?: AbortSignal): Promise<string | null> {
  throwIfScanAborted(signal)
  try {
    const s = await stat(filePath)
    throwIfScanAborted(signal)
    const cache = await loadCache(signal)
    throwIfScanAborted(signal)
    const entry = getEntry(cache, filePath, { mtimeMs: s.mtimeMs, sizeBytes: s.size })
    return entry?.project ?? null
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
  }
  throwIfScanAborted(signal)
  return null
}

export async function fingerprintFile(filePath: string, signal?: AbortSignal): Promise<FileFingerprint | null> {
  throwIfScanAborted(signal)
  try {
    const s = await stat(filePath)
    throwIfScanAborted(signal)
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
    return null
  }
}

export async function writeCachedCodexResults(
  filePath: string,
  project: string,
  calls: ParsedProviderCall[],
  fingerprint: FileFingerprint,
  signal?: AbortSignal,
): Promise<void> {
  throwIfScanAborted(signal)
  try {
    const cache = await loadCache(signal)
    throwIfScanAborted(signal)
    cache.files[filePath] = {
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      project,
      calls,
    }
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
  }
}

export async function flushCodexCache(signal?: AbortSignal): Promise<void> {
  throwIfScanAborted(signal)
  if (!memCache) return
  const original = memCache
  const originalFiles = { ...original.files }
  const cache = { ...original, files: { ...originalFiles } }
  const missing = new Set<string>()
  let tempPath: string | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Evict entries for files that no longer exist on disk
    const paths = Object.keys(cache.files)
    for (const p of paths) {
      throwIfScanAborted(signal)
      try {
        await stat(p)
        throwIfScanAborted(signal)
      } catch (error) {
        throwIfScanAborted(signal)
        if (isScanAbortedError(error)) throw error
        missing.add(p)
      }
    }
    if (missing.size > 0) {
      cache.files = Object.fromEntries(Object.entries(cache.files).filter(([path]) => !missing.has(path)))
    }

    throwIfScanAborted(signal)
    const dir = getCacheDir()
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
      throwIfScanAborted(signal)
    }
    const finalPath = getCachePath()
    tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const payload = JSON.stringify(cache)
    throwIfScanAborted(signal)
    handle = await open(tempPath, 'w', 0o600)
    throwIfScanAborted(signal)
    await handle.writeFile(payload, { encoding: 'utf-8' })
    throwIfScanAborted(signal)
    await handle.sync()
    throwIfScanAborted(signal)
    await handle.close()
    handle = undefined
    throwIfScanAborted(signal)
    await rename(tempPath, finalPath)
    tempPath = undefined
    throwIfScanAborted(signal)
    if (memCache === original) {
      const concurrentWrites = Object.fromEntries(
        Object.entries(original.files).filter(([path, entry]) => originalFiles[path] !== entry),
      )
      memCache = { ...cache, files: { ...cache.files, ...concurrentWrites } }
    } else if (memCache) {
      const unchangedEntriesEvicted = new Set(
        [...missing].filter(path => memCache?.files[path] === original.files[path]),
      )
      if (unchangedEntriesEvicted.size > 0) {
        memCache = {
          ...memCache,
          files: Object.fromEntries(
            Object.entries(memCache.files).filter(([path]) => !unchangedEntriesEvicted.has(path)),
          ),
        }
      }
    }
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
  } finally {
    if (handle) await handle.close().catch(() => {})
    if (tempPath) await unlink(tempPath).catch(() => {})
  }
}
