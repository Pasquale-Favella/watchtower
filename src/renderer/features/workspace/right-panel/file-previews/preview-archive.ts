import JSZip from 'jszip'

import { PREVIEW_LIMIT, type PreviewEntry } from './preview-types.js'

const ENTRY_LIMIT = 10_000
const UNPACKED_LIMIT = 128 * 1024 * 1024

interface ZipOutputStream {
  readonly pause: () => void
  readonly resume: () => void
  on(event: 'data', callback: (bytes: Uint8Array) => void): void
  on(event: 'error', callback: (cause: Error) => void): void
  on(event: 'end', callback: () => void): void
}

function checkedPath(name: string): string {
  if (name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..'))
    throw new Error('Archive contains an invalid entry path.')
  return name.replaceAll('\\', '/')
}

/** Check declared ZIP sizes before a decompressor allocates untrusted entries. */
export function zipPreviewEntries(bytes: ArrayBuffer): readonly PreviewEntry[] {
  if (bytes.byteLength < 22) throw new Error('Invalid ZIP directory.')
  const view = new DataView(bytes)
  let end = -1
  for (let index = Math.max(0, bytes.byteLength - 22); index >= Math.max(0, bytes.byteLength - 65_557); index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end < 0) throw new Error('Invalid ZIP directory.')
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new Error('Multi-volume ZIP files cannot be previewed.')
  const count = view.getUint16(end + 10, true)
  let position = view.getUint32(end + 16, true)
  if (count === 0xffff || count > ENTRY_LIMIT) throw new Error('Archive has too many entries.')
  const entries: PreviewEntry[] = []
  let total = 0
  for (let index = 0; index < count; index++) {
    if (position + 46 > bytes.byteLength || view.getUint32(position, true) !== 0x02014b50)
      throw new Error('Invalid ZIP entry.')
    const encrypted = (view.getUint16(position + 8, true) & 1) !== 0
    const size = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    if (position + 46 + nameLength + extraLength + commentLength > bytes.byteLength)
      throw new Error('Truncated ZIP directory.')
    if (encrypted || size === 0xffffffff || size > PREVIEW_LIMIT || (total += size) > UNPACKED_LIMIT)
      throw new Error('Archive exceeds the preview limits or is encrypted.')
    const name = checkedPath(new TextDecoder().decode(new Uint8Array(bytes, position + 46, nameLength)))
    entries.push({ name, size, directory: name.endsWith('/') })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export interface PreviewArchive {
  readonly entries: readonly PreviewEntry[]
  readonly read: (path: string) => Promise<Uint8Array>
}

function tarArchive(bytes: Uint8Array): PreviewArchive {
  const entries: PreviewEntry[] = []
  const ranges = new Map<string, { offset: number; size: number }>()
  const decoder = new TextDecoder()
  let position = 0
  while (position + 512 <= bytes.byteLength) {
    const header = bytes.subarray(position, position + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) =>
      decoder
        .decode(header.subarray(start, start + length))
        .replace(/\0.*$/, '')
        .trim()
    const prefix = field(345, 155)
    const name = checkedPath(`${prefix ? `${prefix}/` : ''}${field(0, 100)}`)
    const size = parseInt(field(124, 12) || '0', 8)
    const type = field(156, 1)
    if (!Number.isSafeInteger(size) || size < 0 || size > PREVIEW_LIMIT || position + 512 + size > bytes.byteLength)
      throw new Error('Invalid TAR entry size.')
    if (entries.length >= ENTRY_LIMIT) throw new Error('Archive has too many entries.')
    if (type === '' || type === '0' || type === '5') {
      entries.push({ name, size, directory: type === '5' || name.endsWith('/') })
      if (type !== '5') ranges.set(name, { offset: position + 512, size })
    }
    position += 512 + Math.ceil(size / 512) * 512
  }
  if (entries.length === 0) throw new Error('Archive contains no readable entries.')
  return {
    entries,
    read: async name => {
      const range = ranges.get(name)
      if (!range) throw new Error('Archive entry is unavailable.')
      return bytes.slice(range.offset, range.offset + range.size)
    },
  }
}

async function gunzip(bytes: ArrayBuffer): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > UNPACKED_LIMIT) throw new Error('Expanded archive exceeds the preview limit.')
      chunks.push(new Uint8Array(chunk.value))
    }
  } finally {
    await reader.cancel()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function openPreviewArchive(bytes: ArrayBuffer, path: string): Promise<PreviewArchive> {
  if (bytes.byteLength > PREVIEW_LIMIT) throw new Error('File exceeds the preview limit.')
  if (/\.(?:tgz|gz)$/i.test(path)) {
    const expanded = await gunzip(bytes)
    if (/\.(?:tar\.gz|tgz)$/i.test(path)) return tarArchive(expanded)
    const name = path.split('/').at(-1)?.replace(/\.gz$/i, '') ?? 'content'
    return { entries: [{ name, size: expanded.byteLength, directory: false }], read: async () => expanded }
  }
  if (/\.tar$/i.test(path)) return tarArchive(new Uint8Array(bytes))
  const entries = zipPreviewEntries(bytes)
  const zip = await JSZip.loadAsync(bytes)
  return {
    entries,
    read: async name => {
      const entry = zip.file(checkedPath(name))
      if (!entry) throw new Error('Archive entry is unavailable.')
      return new Promise<Uint8Array>((resolve, reject) => {
        // The dependency implements its documented streaming API but omits it from JSZipObject's declaration.
        const stream = (
          entry as typeof entry & { internalStream: (format: 'uint8array') => ZipOutputStream }
        ).internalStream('uint8array')
        const chunks: Uint8Array[] = []
        let size = 0
        stream.on('data', chunk => {
          size += chunk.byteLength
          if (size > PREVIEW_LIMIT) {
            stream.pause()
            reject(new Error('Archive entry exceeds the preview limit.'))
            return
          }
          chunks.push(chunk)
        })
        stream.on('error', reject)
        stream.on('end', () => {
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          resolve(bytes)
        })
        stream.resume()
      })
    },
  }
}
