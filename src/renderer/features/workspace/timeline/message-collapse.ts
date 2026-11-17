/** A user message folds once it runs past this many lines or characters, whichever comes first. */
export const MESSAGE_COLLAPSE_LINES = 8
export const MESSAGE_COLLAPSE_CHARACTERS = 600

export function isCollapsibleMessage(content: string): boolean {
  if (content.length > MESSAGE_COLLAPSE_CHARACTERS) return true
  return content.split('\n').length > MESSAGE_COLLAPSE_LINES
}
