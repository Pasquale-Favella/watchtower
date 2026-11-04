import { useAtomSet } from '@effect/atom-react'
import * as Schema from 'effect/Schema'
import { useCallback } from 'react'

import { isEmbeddedMarkdownImage } from '@/renderer/components/markdown/markdown-url'
import { checkoutFilePathSchema, type CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { checkoutReadFileAtom } from './right-panel/checkout-inspection-atoms.js'

export function useMarkdownImageLoader(
  scope: CheckoutScope | null,
): ((path: string) => Promise<string | null>) | undefined {
  const read = useAtomSet(checkoutReadFileAtom, { mode: 'promise' })
  const projectId = scope?.projectId
  const checkoutId = scope?.checkoutId
  const load = useCallback(
    async (path: string): Promise<string | null> => {
      if (!projectId || !Schema.is(checkoutFilePathSchema)(path)) return null
      const result = await read({ projectId, ...(checkoutId ? { checkoutId } : {}), path })
      if (result.truncated || !result.previewDataUrl || !isEmbeddedMarkdownImage(result.previewDataUrl)) return null
      return result.previewDataUrl
    },
    [projectId, checkoutId, read],
  )
  return scope === null ? undefined : load
}
