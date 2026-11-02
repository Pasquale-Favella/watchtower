import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

export function promptWithAttachments(value: string, attachments: readonly PromptAttachment[]): string {
  if (value.trim()) return value.trim()
  if (attachments.some(item => item.source === 'skill' || item.source === 'command'))
    return 'Apply the attached instructions.'
  return attachments.length ? 'Review the attached files.' : ''
}

export interface PromptTrigger {
  readonly kind: 'file' | 'command'
  readonly query: string
  readonly start: number
  readonly end: number
}

export function promptTrigger(value: string, caret: number): PromptTrigger | null {
  const match = /(?:^|\s)([@/$])([^\s]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  return {
    kind: match[1] === '@' ? 'file' : 'command',
    query: match[2],
    start: caret - match[2].length - 1,
    end: caret,
  }
}

/** Continue Markdown lists while preserving the ability to submit an ordinary prompt. */
export function continuePromptList(value: string, start: number, end: number): { value: string; caret: number } | null {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const line = value.slice(lineStart, start)
  const match = /^(\s*)([-*+] |\d+[.)] )(\[[ xX]\] )?(.*)$/.exec(line)
  if (!match) return null
  if (!match[4].trim()) return { value: value.slice(0, lineStart) + value.slice(end), caret: lineStart }
  const marker = /^\d/.test(match[2]) ? match[2].replace(/^\d+/, number => String(Number(number) + 1)) : match[2]
  const insertion = `\n${match[1]}${marker}${match[3] ? '[ ] ' : ''}`
  return { value: value.slice(0, start) + insertion + value.slice(end), caret: start + insertion.length }
}
