import { filePromptToken } from '@/shared/prompt-links.js'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'
export { filePromptToken } from '@/shared/prompt-links.js'

import { collectPromptInlineTokens } from './prompt-tokens.js'

export function promptWithAttachments(value: string, attachments: readonly PromptAttachment[]): string {
  if (value.trim()) return value.trim()
  if (attachments.some(item => item.source === 'skill' || item.source === 'command'))
    return 'Apply the attached instructions.'
  return attachments.length ? 'Review the attached files.' : ''
}

export function visiblePromptAttachments(attachments: readonly PromptAttachment[]): readonly PromptAttachment[] {
  return attachments.filter(attachment => attachment.source === 'file' && attachment.mediaType.startsWith('image/'))
}

export function commandPromptToken(name: string): string {
  let invocation = name.replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '')
  const commandDirectory = invocation.lastIndexOf('/commands/')
  if (commandDirectory >= 0) invocation = invocation.slice(commandDirectory + '/commands/'.length)
  return `/${invocation.replace(/\.md$/i, '')} `
}

export function attachmentPromptToken(attachment: PromptAttachment): string {
  const label = attachment.name.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  return `[${label}](attachment:${attachment.id}) `
}

function containsPromptToken(value: string, token: string): boolean {
  let start = 0
  while ((start = value.indexOf(token, start)) >= 0) {
    const end = start + token.length
    if ((start === 0 || /\s/.test(value[start - 1] ?? '')) && (end === value.length || /\s/.test(value[end] ?? '')))
      return true
    start += 1
  }
  return false
}

export function promptContextAttachmentIsReferenced(value: string, attachment: PromptAttachment): boolean {
  if (attachment.source === 'file') {
    if (attachment.mediaType.startsWith('image/')) return true
    return collectPromptInlineTokens(value).some(token => token.type === 'attachment' && token.value === attachment.id)
  }
  if (attachment.source === 'reference') {
    return (
      collectPromptInlineTokens(value).some(token => token.type === 'mention' && token.value === attachment.name) ||
      containsPromptToken(value, filePromptToken(attachment.name).trim())
    )
  }
  if (attachment.source === 'skill') {
    const invocation = attachment.token?.trim() ?? skillPromptToken(attachment.name).trim()
    const prefix = /^\p{Sc}/u.exec(invocation)?.[0]
    const name = prefix ? invocation.slice(prefix.length) : ''
    return (
      (name !== '' && collectPromptInlineTokens(value).some(token => token.type === 'skill' && token.value === name)) ||
      containsPromptToken(value, invocation)
    )
  }
  if (attachment.source === 'command')
    return containsPromptToken(value, attachment.token?.trim() ?? commandPromptToken(attachment.name).trim())
  return true
}

export interface PromptTrigger {
  readonly kind: 'file' | 'command' | 'skill' | 'pullRequest'
  readonly query: string
  readonly start: number
  readonly end: number
  readonly modelQuery?: string
}

export function isWhitespaceChar(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r'
}

/** Currency amounts such as `$5`, `€9.99` and `$10k` are money, not skills. */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query)
}

/** A second slash makes the whole word a path, so `/src/foo` is never a command. */
export function isPathWord(value: string, start: number, caret: number): boolean {
  let end = caret
  while (end < value.length && !isWhitespaceChar(value[end])) end += 1
  return value.slice(start + 1, end).includes('/')
}

function clampCaret(value: string, caret: number): number {
  return Number.isFinite(caret) ? Math.max(0, Math.min(value.length, Math.floor(caret))) : value.length
}

export function promptTrigger(value: string, caret: number): PromptTrigger | null {
  const end = clampCaret(value, caret)
  const lineStart = value.lastIndexOf('\n', end - 1) + 1
  if (lineStart === 0) {
    const modelMatch = /^\/model\s+(.*)$/i.exec(value.slice(0, end))
    if (modelMatch) return { kind: 'command', query: 'model', start: 0, end, modelQuery: modelMatch[1] ?? '' }
  }
  let index = end - 1
  while (index >= 0 && !isWhitespaceChar(value[index])) index -= 1
  const start = index + 1
  const token = value.slice(start, end)
  if (token.startsWith('@')) return { kind: 'file', query: token.slice(1), start, end }
  if (/^#[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(token) || token === '#')
    return { kind: 'pullRequest', query: token.slice(1), start, end }
  if (token.startsWith('/')) {
    if (isPathWord(value, start, end)) return null
    return { kind: 'command', query: token.slice(1), start, end }
  }
  const skillPrefix = /^\p{Sc}/u.exec(token)
  if (skillPrefix && !isCurrencyAmountQuery(token.slice(skillPrefix[0].length)))
    return { kind: 'skill', query: token.slice(skillPrefix[0].length), start, end }
  return null
}

/** The `$…` token a skill attachment inserts into the prompt, keyed by the attachment's SKILL.md path. */
export function skillPromptToken(name: string): string {
  const label =
    name
      .replace(/[\\/]SKILL\.md$/, '')
      .split(/[\\/]/)
      .pop() ?? name
  return `$${label} `
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

export function limitPromptEdit(
  previousValue: string,
  value: string,
  cursor: number,
  maxLength: number,
): { value: string; cursor: number } {
  const limit = Math.max(0, Math.floor(maxLength))
  if (value.length <= limit) return { value, cursor: Math.max(0, Math.min(cursor, value.length)) }

  let prefix = 0
  while (prefix < previousValue.length && prefix < value.length && previousValue[prefix] === value[prefix]) prefix++

  let suffix = 0
  while (
    suffix < previousValue.length - prefix &&
    suffix < value.length - prefix &&
    previousValue[previousValue.length - suffix - 1] === value[value.length - suffix - 1]
  )
    suffix++

  const insertedEnd = value.length - suffix
  const allowed = Math.max(0, limit - prefix - suffix)
  const nextValue = value.slice(0, prefix + allowed) + value.slice(insertedEnd)
  const removed = insertedEnd - prefix - allowed
  let nextCursor = cursor
  if (cursor > prefix && cursor <= insertedEnd) nextCursor = prefix + Math.min(cursor - prefix, allowed)
  else if (cursor > insertedEnd) nextCursor = cursor - removed
  return { value: nextValue, cursor: Math.max(0, Math.min(nextCursor, nextValue.length)) }
}

export function promptPasteUsesAttachment(
  currentValue: string,
  pastedText: string,
  start: number,
  end: number,
  maxLength: number,
  forcePlainText = false,
): boolean {
  if (forcePlainText) return false
  const resultLength = currentValue.length - Math.max(0, end - start) + pastedText.length
  return new TextEncoder().encode(pastedText).byteLength >= 32 * 1024 || resultLength > maxLength
}
