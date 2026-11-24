import type { UrlTransform } from 'streamdown'

const embeddedImagePattern = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i
const rasterImagePath = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i

export function isExternalMarkdownUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  if (Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))
    return false
  return URL.canParse(value)
}

export function isEmbeddedMarkdownImage(value: string): boolean {
  return embeddedImagePattern.test(value)
}

export function markdownFilePath(value: string, workspacePath?: string): string | undefined {
  let path: string
  try {
    path = decodeURIComponent(value)
  } catch {
    return undefined
  }
  if (
    Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    path.startsWith('#') ||
    path.startsWith('//')
  )
    return undefined
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '')
  if (path.startsWith('file://')) {
    if (!/^file:\/\/\//.test(path)) return undefined
    path = path.slice(7).replace(/^\/(?=[a-z]:\/)/i, '')
  }
  path = path.replace(/\\/g, '/')
  if (path.startsWith('/') || /^[a-z]:\//i.test(path)) {
    if (!workspacePath) return undefined
    const root = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')
    const windows = /^[a-z]:\//i.test(root)
    const target = windows ? path.toLowerCase() : path
    const base = windows ? root.toLowerCase() : root
    if (!target.startsWith(`${base}/`)) return undefined
    path = path.slice(root.length + 1)
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || /[?#]/.test(path)) return undefined
  const segments = path.split('/').filter(segment => segment !== '.' && segment !== '')
  if (!segments.length || segments.includes('..')) return undefined
  return segments.join('/')
}

function isFileReference(value: string): boolean {
  return markdownFilePath(value) !== undefined || /^file:\/\/\//i.test(value) || /^(?:\/|[a-z]:[\\/])/i.test(value)
}

export function markdownImagePath(value: string, workspacePath?: string): string | undefined {
  const path = markdownFilePath(value, workspacePath)
  return path !== undefined && path.length <= 4096 && rasterImagePath.test(path) ? path : undefined
}

function isLocalImageReference(value: string): boolean {
  if (!isFileReference(value)) return false
  try {
    return rasterImagePath.test(decodeURIComponent(value))
  } catch {
    return false
  }
}

export const markdownUrlTransform: UrlTransform = (value, key) => {
  if (isExternalMarkdownUrl(value)) return value
  if (key === 'src' && isEmbeddedMarkdownImage(value)) return value
  if (key === 'src' && isLocalImageReference(value)) return value
  if (key === 'href' && /^#[\w-]+$/.test(value)) return value
  if (key === 'href' && isFileReference(value)) return value
  return undefined
}
