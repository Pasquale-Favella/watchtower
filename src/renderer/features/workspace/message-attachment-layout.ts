import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { splitPromptTokens } from './prompt-tokens.js'

export function messageAttachmentLayout(
  content: string | undefined,
  attachments: readonly PromptAttachment[],
): { readonly hideBody: boolean; readonly attachments: readonly PromptAttachment[] } {
  const imported = attachments.filter(item => item.source === 'file' && !item.annotation)
  const segments = splitPromptTokens(content ?? '', undefined, {
    allowTrailingEnd: true,
    resolveAttachment: id => imported.find(item => item.id === id) ?? null,
  })
  const referenced = new Set(segments.flatMap(segment => (segment.type === 'attachment' ? [segment.id] : [])))
  const hideBody =
    content !== undefined &&
    imported.length > 0 &&
    segments.every(segment => segment.type === 'attachment' || (segment.type === 'text' && segment.text.trim() === ''))
  return {
    hideBody,
    attachments: imported.filter(item => item.mediaType.startsWith('image/') || hideBody || !referenced.has(item.id)),
  }
}
