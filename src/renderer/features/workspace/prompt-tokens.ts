/**
 * File references, attachment chips, and currency-prefixed skill tokens in prompt text.
 * Raw text needs a trailing delimiter; an
 * already confirmed editor token can be preserved when that delimiter is removed.
 */

import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

export type PromptInlineToken =
  | {
      readonly type: 'mention'
      readonly value: string
      readonly source: string
      readonly start: number
      readonly end: number
    }
  | {
      readonly type: 'skill'
      readonly value: string
      readonly source: string
      readonly start: number
      readonly end: number
    }
  | {
      readonly type: 'attachment'
      readonly value: string
      readonly source: string
      readonly start: number
      readonly end: number
    }

export interface PromptInlineTokensOptions {
  readonly preserveTrailingFrom?: readonly PromptInlineToken[]
  readonly resolveAttachment?: (id: string) => PromptAttachment | null
  readonly resolveReference?: (path: string) => PromptAttachment | null
}

export type PromptSegment =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'mention'
      readonly path: string
      readonly source: string
      readonly label: string
      readonly attachment?: PromptAttachment
    }
  | { readonly type: 'skill'; readonly name: string; readonly source: string; readonly label: string }
  | {
      readonly type: 'attachment'
      readonly id: string
      readonly source: string
      readonly label: string
      readonly mediaType: string
      readonly attachment: PromptAttachment
    }

const SKILL_MENTION_SOURCE =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)/u
    .source
const SKILL_TOKEN_REGEX = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s)`, 'gu')
export const SKILL_MENTION_PATTERN = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s|$)`, 'gu')
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g
// Bound unmatched-bracket rescans to avoid quadratic work; only basenames survive.
const MAX_FILE_LINK_LABEL_LENGTH = 512
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)(?=\\s)`,
  'g',
)
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/
const SCOPED_PACKAGE_REFERENCE_REGEX = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9_-]*(?:\/[^\s@"]+)*$/
const DECORATOR_CALL_REFERENCE_REGEX = /^[\p{ID_Start}_$][\p{ID_Continue}.$‌‍]*\(/u

export function basenameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const basename = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed
  if (!basename) return path
  if (path.endsWith('\\')) return `${basename}\\`
  if (path.endsWith('/')) return `${basename}/`
  return basename
}

function collectMentionTokens(text: string): PromptInlineToken[] {
  const matches: PromptInlineToken[] = []

  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const fullMatch = match[0]
    const prefix = match[1] ?? ''
    const label = (match[2] ?? '').replaceAll(/\\(.)/g, '$1')
    const encodedPath = match[3] ?? ''
    const attachmentId = /^attachment:([a-f0-9]{64})$/.exec(encodedPath)?.[1]
    if (attachmentId) {
      if (!label) continue
      const start = (match.index ?? 0) + prefix.length
      const end = start + fullMatch.length - prefix.length
      matches.push({ type: 'attachment', value: attachmentId, source: text.slice(start, end), start, end })
      continue
    }
    let path = encodedPath
    try {
      path = decodeURIComponent(encodedPath)
    } catch {
      /* Keep the raw destination when it is not valid percent encoding. */
    }
    const hasExternalScheme = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path)
    if (!path || hasExternalScheme || label !== basenameOfPath(path)) continue
    const start = (match.index ?? 0) + prefix.length
    const end = start + fullMatch.length - prefix.length
    matches.push({ type: 'mention', value: path, source: text.slice(start, end), start, end })
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0]
    const prefix = match[1] ?? ''
    const quotedPath = match[2]
    const path = quotedPath !== undefined ? quotedPath.replaceAll(/\\(.)/g, '$1') : (match[3] ?? '')
    if (
      !path ||
      (quotedPath === undefined &&
        (SCOPED_PACKAGE_REFERENCE_REGEX.test(path) || DECORATOR_CALL_REFERENCE_REGEX.test(path)))
    )
      continue
    const start = (match.index ?? 0) + prefix.length
    const end = start + fullMatch.length - prefix.length
    matches.push({ type: 'mention', value: path, source: text.slice(start, end), start, end })
  }

  return matches
}

/** Every inline reference and `$skill` token in the text, ordered by position. */
export function collectPromptInlineTokens(
  text: string,
  options: PromptInlineTokensOptions = {},
): readonly PromptInlineToken[] {
  const matches = collectMentionTokens(text)

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const fullMatch = match[0]
    const prefix = match[1] ?? ''
    const value = match[2] ?? ''
    if (!value) continue
    const start = (match.index ?? 0) + prefix.length
    const end = start + fullMatch.length - prefix.length
    matches.push({ type: 'skill', value, source: text.slice(start, end), start, end })
  }

  for (const token of options.preserveTrailingFrom ?? []) {
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(match => match.type === token.type && match.start === token.start && match.end === token.end)
    ) {
      matches.push(token)
    }
  }

  return matches.sort((left, right) => left.start - right.start)
}

/** Splits prompt text into flat text runs and token segments; token sources are exactly `text.slice(start, end)`. */
export function splitPromptTokens(
  text: string,
  resolveSkill: (name: string) => { readonly label: string } | null = () => null,
  options: PromptInlineTokensOptions = {},
): readonly PromptSegment[] {
  const segments: PromptSegment[] = []
  if (!text) return segments

  function pushText(value: string): void {
    if (!value) return
    const previous = segments.at(-1)
    if (previous?.type === 'text') {
      segments[segments.length - 1] = { type: 'text', text: previous.text + value }
    } else {
      segments.push({ type: 'text', text: value })
    }
  }

  let cursor = 0
  for (const match of collectPromptInlineTokens(text, options)) {
    if (match.start < cursor) continue
    if (match.start > cursor) pushText(text.slice(cursor, match.start))
    cursor = match.end
    if (match.type === 'attachment') {
      const attachment = options.resolveAttachment?.(match.value)
      if (!attachment) {
        pushText(match.source)
        continue
      }
      segments.push({
        type: 'attachment',
        id: match.value,
        source: match.source,
        label: attachment.name,
        mediaType: attachment.mediaType,
        attachment,
      })
      continue
    }
    if (match.type === 'mention') {
      const attachment = options.resolveReference?.(match.value) ?? undefined
      segments.push({
        type: 'mention',
        path: match.value,
        source: match.source,
        label: basenameOfPath(match.value),
        ...(attachment ? { attachment } : {}),
      })
      continue
    }
    const skill = resolveSkill(match.value)
    if (!skill) {
      pushText(match.source)
      continue
    }
    segments.push({ type: 'skill', name: match.value, source: match.source, label: skill.label })
  }

  if (cursor < text.length) pushText(text.slice(cursor))
  return segments
}

/** `Aria references` may cross token boundaries; whitespace beside a token starts a new word. */
export function selectionTouchesMentionBoundary(prompt: string, start: number, end: number): boolean {
  if (!prompt || start >= end) return false
  return collectPromptInlineTokens(prompt).some(token => {
    const beforeMentionIndex = token.start - 1
    const afterMentionIndex = token.end
    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? '') &&
      start <= beforeMentionIndex &&
      beforeMentionIndex < end
    )
      return true
    return /\s/.test(prompt[afterMentionIndex] ?? '') && start <= afterMentionIndex && afterMentionIndex < end
  })
}
