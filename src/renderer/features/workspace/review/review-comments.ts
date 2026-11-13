import type { SelectedLineRange } from '@pierre/diffs'

import { parseUnifiedDiff } from '../right-panel/unified-diff.js'

export interface ReviewComment {
  readonly id: string
  readonly sectionId: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly side?: 'additions' | 'deletions' | undefined
  readonly endSide?: 'additions' | 'deletions' | undefined
  readonly text: string
  readonly snippet: string
  readonly language: string
  readonly source?: 'file' | 'diff' | undefined
}

export function formatRange(startLine: number, endLine: number): string {
  if (startLine === endLine) return `L${startLine}`
  return `L${Math.min(startLine, endLine)} to L${Math.max(startLine, endLine)}`
}

export function buildReviewComment(input: {
  readonly id?: string | undefined
  readonly sectionId: string
  readonly path: string
  readonly range: SelectedLineRange
  readonly text: string
  readonly contents?: string | undefined
  readonly patch?: string | undefined
}): ReviewComment {
  const startLine = Math.min(input.range.start, input.range.end)
  const endLine = Math.max(input.range.start, input.range.end)
  let snippet = (input.contents ?? '')
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n')
  if (input.patch !== undefined) {
    const rows = parseUnifiedDiff(input.patch).hunks.flatMap(hunk => hunk.lines)
    const startSide = input.range.side ?? 'additions'
    const endSide = input.range.endSide ?? startSide
    const first = rows.findIndex(
      row => (startSide === 'deletions' ? row.oldNumber : row.newNumber) === input.range.start,
    )
    const last = rows.findIndex(row => (endSide === 'deletions' ? row.oldNumber : row.newNumber) === input.range.end)
    if (first >= 0 && last >= 0) {
      snippet = rows
        .slice(Math.min(first, last), Math.max(first, last) + 1)
        .map(row => `${row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '-' : ' '}${row.text}`)
        .join('\n')
    }
  }
  return {
    id: input.id ?? crypto.randomUUID(),
    sectionId: input.sectionId,
    path: input.path,
    startLine,
    endLine,
    ...(input.range.side ? { side: input.range.side } : {}),
    ...(input.range.endSide ? { endSide: input.range.endSide } : {}),
    text: input.text.trim(),
    snippet,
    language: input.patch === undefined ? (input.path.split('.').at(-1) ?? 'text') : 'diff',
    source: input.patch === undefined ? 'file' : 'diff',
  }
}

function fencedSnippet(comment: ReviewComment): string {
  let longest = 2
  for (const match of comment.snippet.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(longest + 1)
  return `${fence}${comment.language}\n${comment.snippet}\n${fence}`
}

export function reviewCommentPrompt(comment: ReviewComment): string {
  const side = comment.side === 'deletions' ? ' before' : ''
  return `Review comment (${comment.id}) on ${comment.path}:${formatRange(comment.startLine, comment.endLine)}${side}\n${fencedSnippet(comment)}\n${comment.text}`
}

export function promptWithReviewComments(prompt: string, comments: readonly ReviewComment[]): string {
  const sections = comments.filter(comment => !prompt.includes(reviewCommentPrompt(comment))).map(reviewCommentPrompt)
  return [prompt.trim(), ...sections].filter(Boolean).join('\n\n')
}

export function reviewCommentsIncludedInPrompt(
  prompt: string,
  comments: readonly ReviewComment[],
): readonly ReviewComment[] {
  return comments.filter(comment => prompt.includes(reviewCommentPrompt(comment)))
}

export function withoutCapturedReviewComments(
  current: readonly ReviewComment[],
  captured: readonly ReviewComment[],
): readonly ReviewComment[] {
  const sent = new Map(captured.map(comment => [comment.id, reviewCommentPrompt(comment)]))
  return current.filter(comment => sent.get(comment.id) !== reviewCommentPrompt(comment))
}
