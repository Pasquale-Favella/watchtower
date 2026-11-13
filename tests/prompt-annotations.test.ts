import { describe, expect, it } from 'vitest'

import { promptAnnotationLabel, promptWithAnnotationContext } from '@/shared/prompt-annotations.js'
import type { PromptAnnotation, PromptAttachment } from '@/shared/schemas/prompt-context.js'

const annotation: PromptAnnotation = {
  pageUrl: 'http://localhost:3000/',
  pageTitle: 'Preview',
  comment: 'Fix spacing',
  elementCount: 1,
  regionCount: 0,
  context: 'Selector: #greet\nSource: src/Button.tsx:12',
}
const attachment: PromptAttachment = {
  id: 'a'.repeat(64),
  name: 'workspace-screenshot.png',
  mediaType: 'image/png',
  size: 1,
  source: 'file',
  annotation,
}

describe('prompt annotations', () => {
  it('uses a compact comment label with page and empty fallbacks', () => {
    expect(promptAnnotationLabel({ ...annotation, comment: '  Fix\n spacing  ' })).toBe('Fix spacing')
    expect(promptAnnotationLabel({ ...annotation, comment: '' })).toBe('Preview')
    expect(promptAnnotationLabel({ ...annotation, comment: '', pageTitle: '' })).toBe('Page annotation')
    expect(promptAnnotationLabel({ ...annotation, comment: 'x'.repeat(63) + '😀' })).toBe('x'.repeat(63) + '…')
  })

  it('adds detailed context only to the dispatched prompt and leaves ordinary messages intact', () => {
    expect(promptWithAnnotationContext('Review this', [])).toBe('Review this')
    expect(promptWithAnnotationContext('Review this', [attachment])).toBe(
      `Review this\n\n<browser-annotation attachment="${attachment.id}">\n${annotation.context}\n</browser-annotation>`,
    )
  })
})
