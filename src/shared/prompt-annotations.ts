import type { PromptAnnotation, PromptAttachment } from './schemas/prompt-context.js'

export function promptAnnotationLabel(annotation: PromptAnnotation): string {
  const label = annotation.comment.trim().replace(/\s+/g, ' ') || annotation.pageTitle.trim() || 'Page annotation'
  return label.length > 64 ? `${label.slice(0, 63).replace(/[\uD800-\uDBFF]$/, '')}…` : label
}

/** Detailed browser context is delivered to the Harness without replacing the user's editable draft. */
export function promptWithAnnotationContext(prompt: string, attachments: readonly PromptAttachment[]): string {
  const annotations = attachments.flatMap(item =>
    item.annotation ? [{ id: item.id, context: item.annotation.context }] : [],
  )
  if (!annotations.length) return prompt
  return `${prompt}\n\n${annotations
    .map(item => `<browser-annotation attachment="${item.id}">\n${item.context}\n</browser-annotation>`)
    .join('\n\n')}`
}
