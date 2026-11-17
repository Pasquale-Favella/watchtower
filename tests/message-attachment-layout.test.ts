import { describe, expect, it } from 'vitest'

import { messageAttachmentLayout } from '@/renderer/features/workspace/message-attachment-layout.js'
import { attachmentPromptToken } from '@/renderer/features/workspace/prompt-editor.js'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

const image: PromptAttachment = {
  id: 'a'.repeat(64),
  name: 'photo.png',
  source: 'file',
  mediaType: 'image/png',
  size: 42,
}
const pdf: PromptAttachment = {
  id: 'b'.repeat(64),
  name: 'report.pdf',
  source: 'file',
  mediaType: 'application/pdf',
  size: 123,
}

describe('message attachment layout', () => {
  it('shows media above mixed text and keeps referenced PDFs inline without duplicate cards', () => {
    expect(
      messageAttachmentLayout(`Review ${attachmentPromptToken(image)} ${attachmentPromptToken(pdf)}`, [image, pdf]),
    ).toEqual({ hideBody: false, attachments: [image] })
  })
  it('shows attachments without a text bubble when only attachment tokens were sent', () => {
    expect(messageAttachmentLayout(attachmentPromptToken(image), [image])).toEqual({
      hideBody: true,
      attachments: [image],
    })
    expect(messageAttachmentLayout(attachmentPromptToken(pdf), [pdf])).toEqual({ hideBody: true, attachments: [pdf] })
    expect(messageAttachmentLayout(attachmentPromptToken(image) + attachmentPromptToken(pdf), [image, pdf])).toEqual({
      hideBody: true,
      attachments: [image, pdf],
    })
  })
  it('keeps legacy files accessible and never hides unresolved references or annotation chips', () => {
    expect(messageAttachmentLayout('Review this', [pdf])).toEqual({ hideBody: false, attachments: [pdf] })
    expect(messageAttachmentLayout(attachmentPromptToken(pdf), [])).toEqual({ hideBody: false, attachments: [] })
    expect(messageAttachmentLayout(undefined, [pdf])).toEqual({ hideBody: false, attachments: [pdf] })
    const annotation = {
      ...image,
      annotation: {
        pageUrl: 'http://localhost/',
        pageTitle: '',
        comment: 'Fix',
        elementCount: 1,
        regionCount: 0,
        context: 'Selector: #greet',
      },
    }
    expect(messageAttachmentLayout(attachmentPromptToken(annotation), [annotation])).toEqual({
      hideBody: false,
      attachments: [],
    })
  })
})
