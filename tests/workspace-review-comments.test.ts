import { describe, expect, it } from 'vitest'

import {
  buildReviewComment,
  promptWithReviewComments,
  reviewCommentPrompt,
  reviewCommentsIncludedInPrompt,
  withoutCapturedReviewComments,
} from '../src/renderer/features/workspace/review/review-comments.js'

describe('workspace review comments', () => {
  it('captures a selected file range and fences embedded markdown safely', () => {
    const comment = buildReviewComment({
      id: 'one',
      sectionId: 'file:a.md',
      path: 'a.md',
      range: { start: 4, end: 2 },
      text: ' Explain this ',
      contents: '# Heading\n```ts\nconst value = 1\n```\n',
    })
    expect(comment).toMatchObject({
      startLine: 2,
      endLine: 4,
      text: 'Explain this',
      snippet: '```ts\nconst value = 1\n```',
    })
    expect(reviewCommentPrompt(comment)).toContain('````md\n```ts\nconst value = 1\n```\n````')
  })

  it('captures the deletion side without substituting the addition at the same line number', () => {
    const comment = buildReviewComment({
      id: 'two',
      sectionId: 'working-tree',
      path: 'example.ts',
      range: { start: 2, end: 2, side: 'deletions' },
      text: 'Keep this behavior',
      patch: '@@ -1,3 +1,3 @@\n first\n-old value\n+new value\n last',
    })
    expect(comment.snippet).toBe('-old value')
    expect(reviewCommentPrompt(comment)).toContain(' before\n```diff')
  })

  it('adds each captured comment once and supports a prompt made entirely of comments', () => {
    const comment = buildReviewComment({
      id: 'three',
      sectionId: 'file:a.ts',
      path: 'a.ts',
      range: { start: 1, end: 1 },
      text: 'Fix this',
      contents: 'broken()',
    })
    const prompt = promptWithReviewComments('', [comment])
    expect(prompt).toContain('Fix this')
    expect(promptWithReviewComments(prompt, [comment])).toBe(prompt)
    expect(reviewCommentsIncludedInPrompt(prompt, [comment])).toEqual([comment])
  })

  it('clears only the accepted snapshot and preserves edits and comments made during submission', () => {
    const captured = buildReviewComment({
      id: 'captured',
      sectionId: 'file:a.ts',
      path: 'a.ts',
      range: { start: 1, end: 1 },
      text: 'Fix this',
      contents: 'broken()',
    })
    const added = { ...captured, id: 'added', text: 'A new comment' }
    expect(withoutCapturedReviewComments([captured, added], [captured])).toEqual([added])
    const edited = { ...captured, text: 'Revised while submitting' }
    expect(withoutCapturedReviewComments([edited, added], [captured])).toEqual([edited, added])
  })
})
