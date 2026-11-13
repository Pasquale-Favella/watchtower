import { useEffect, useState } from 'react'

import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { usePromptAttachmentPreview } from './prompt-context-hooks.js'

export function usePromptAttachmentSource(
  attachment: PromptAttachment,
  enabled: boolean,
): { readonly source: string | null; readonly error: string | null; readonly retry: () => void } {
  const preview = usePromptAttachmentPreview()
  const [result, setResult] = useState<{
    readonly id: string
    readonly source: string | null
    readonly error: string | null
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = result?.id === attachment.id ? result : null
  const source = current?.source ?? null
  useEffect(() => {
    if (!enabled || source) return
    let active = true
    void preview(attachment).then(
      value => {
        if (!active) return
        setResult({
          id: attachment.id,
          source: value,
          error: value ? null : 'Preview is not available for this attachment.',
        })
      },
      () => {
        if (active) setResult({ id: attachment.id, source: null, error: 'Could not load this attachment preview.' })
      },
    )
    return () => {
      active = false
    }
  }, [attachment, enabled, preview, attempt, source])
  return {
    source,
    error: current?.error ?? null,
    retry: () => {
      setResult(null)
      setAttempt(value => value + 1)
    },
  }
}
