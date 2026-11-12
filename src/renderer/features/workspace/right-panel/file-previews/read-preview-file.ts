import { PREVIEW_LIMIT } from './preview-types.js'

export async function readPreviewFile(source: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(source, { signal })
  if (!response.ok) throw new Error('The file could not be read.')
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > PREVIEW_LIMIT) throw new Error('File exceeds the preview limit.')
  if (!response.body) throw new Error('The file contains no readable content.')
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > PREVIEW_LIMIT) throw new Error('File exceeds the preview limit.')
      chunks.push(new Uint8Array(result.value))
    }
  } finally {
    await reader.cancel()
  }
  return new Blob(chunks).arrayBuffer()
}
