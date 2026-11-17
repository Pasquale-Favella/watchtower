import * as Schema from 'effect/Schema'

import { checkoutFilePathSchema } from '@/shared/schemas/checkout-inspection.js'

/** Resolve document-relative references without allowing a checkout escape or native URL scheme. */
export function resolvePreviewReference(documentPath: string, reference: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    return undefined
  }
  if (!decoded || /^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(decoded)) return undefined
  const target = decoded.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '')
  if (/[?#]/.test(target)) return undefined
  const segments = documentPath.split('/').slice(0, -1)
  for (const part of target.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else segments.push(part)
  }
  const path = segments.join('/')
  return Schema.is(checkoutFilePathSchema)(path) ? path : undefined
}
