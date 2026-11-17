import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { codeProcessingWorkerContracts } from '../src/renderer/features/workspace/right-panel/code-processing-protocol.js'
import { searchCodeFiles } from '../src/renderer/features/workspace/right-panel/code-search.js'
import { codeWorkerCount } from '../src/renderer/features/workspace/right-panel/code-worker-budget.js'
import { reviewDiffMetadata } from '../src/renderer/features/workspace/right-panel/diff-review-model.js'

const OPTIONS = { query: 'query', matchCase: false, wholeWord: false, regexp: false }

it('bounds the shared highlighting pool below the available CPU count', () => {
  expect([0, 1, 2, 4, 8, 128].map(codeWorkerCount)).toEqual([1, 1, 1, 1, 2, 2])
})

describe('complete code search', () => {
  it.each([
    {
      status: 'added' as const,
      patch:
        'diff --git a/file.ts b/file.ts\nnew file mode 100644\n--- /dev/null\n+++ b/file.ts\n@@ -0,0 +1 @@\n+new\n',
      oldContent: '',
      newContent: 'new\n',
      absentSide: 'deletionLineIndex' as const,
    },
    {
      status: 'deleted' as const,
      patch:
        'diff --git a/file.ts b/file.ts\ndeleted file mode 100644\n--- a/file.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
      oldContent: 'old\n',
      newContent: '',
      absentSide: 'additionLineIndex' as const,
    },
  ])('accepts absent-side indices for complete $status files at both worker boundaries', fixture => {
    const metadata = reviewDiffMetadata(
      { path: 'file.ts', status: fixture.status, additions: 1, deletions: 1, binary: false },
      {
        patch: fixture.patch,
        oldContent: fixture.oldContent,
        newContent: fixture.newContent,
        binary: false,
        truncated: false,
      },
      fixture.status,
    )
    expect(metadata.hunks).toHaveLength(1)
    expect(metadata.hunks[0]?.[fixture.absentSide]).toBe(-1)
    expect(metadata.hunks[0]?.hunkContent[0]?.[fixture.absentSide]).toBe(-1)
    expect(Schema.is(codeProcessingWorkerContracts.process.output)({ kind: 'metadata', metadata })).toBe(true)
    expect(
      Schema.is(codeProcessingWorkerContracts.process.input)({
        kind: 'search',
        files: [
          {
            id: fixture.status,
            name: 'file.ts',
            before: metadata.deletionLines,
            after: metadata.additionLines,
            diff: metadata,
          },
        ],
        options: OPTIONS,
      }),
    ).toBe(true)
    const invalid = { ...metadata, hunks: [{ ...metadata.hunks[0], [fixture.absentSide]: -2 }] }
    expect(Schema.is(codeProcessingWorkerContracts.process.output)({ kind: 'metadata', metadata: invalid })).toBe(false)
  })

  const files = [
    { id: 'folded', name: 'folded.ts', before: ['old\n'], after: ['needle added\n'] },
    {
      id: 'context',
      name: 'context.ts',
      before: ['one\n', 'needle in hidden context\n'],
      after: ['changed\n', 'needle in hidden context\n'],
    },
  ]
  it('finds folded and unchanged context without double-counting identical context rows', () => {
    const result = searchCodeFiles(files, { ...OPTIONS, query: 'needle' })
    expect(result.matches.map(match => [match.id, match.line, match.side])).toEqual([
      ['folded', 1, 'additions'],
      ['context', 2, 'additions'],
    ])
  })
  it('supports literal text, case, words, regular expressions and bounded matches', () => {
    const source = [{ id: 'file', name: 'f.ts', before: [], after: ['Needle needle needles a.b aXb\n'] }]
    expect(
      searchCodeFiles(source, { ...OPTIONS, query: 'needle', matchCase: true, wholeWord: true }).matches,
    ).toHaveLength(1)
    expect(searchCodeFiles(source, { ...OPTIONS, query: 'a.b' }).matches).toHaveLength(1)
    expect(searchCodeFiles(source, { ...OPTIONS, query: 'n[a-z]+', regexp: true }).matches).toHaveLength(3)
    expect(() => searchCodeFiles(source, { ...OPTIONS, query: '[', regexp: true })).toThrow()
    const bounded = searchCodeFiles([{ id: 'large', name: 'f', before: [], after: ['x '.repeat(3000)] }], {
      ...OPTIONS,
      query: 'x',
    })
    expect(bounded.matches).toHaveLength(2000)
    expect(bounded.truncated).toBe(true)
  })

  it('preserves original line numbers for partial patches and excludes unchanged old-side context', () => {
    const metadata = reviewDiffMetadata(
      { path: 'partial.ts', status: 'modified', additions: 1, deletions: 1, binary: false },
      {
        patch:
          'diff --git a/partial.ts b/partial.ts\n--- a/partial.ts\n+++ b/partial.ts\n@@ -900,2 +1000,2 @@\n needle context\n-old needle\n+new needle\n',
        truncated: false,
        binary: false,
      },
      'partial',
    )
    const result = searchCodeFiles(
      [
        {
          id: 'partial',
          name: 'partial.ts',
          before: metadata.deletionLines,
          after: metadata.additionLines,
          diff: metadata,
        },
      ],
      { ...OPTIONS, query: 'needle' },
    )
    expect(result.matches.map(match => [match.line, match.side])).toEqual([
      [1000, 'additions'],
      [1001, 'additions'],
      [901, 'deletions'],
    ])
    expect(
      Schema.is(codeProcessingWorkerContracts.process.output)({
        kind: 'search',
        matches: result.matches,
        truncated: false,
      }),
    ).toBe(true)
  })

  it('validates Pierre metadata fields while preserving additional library fields', () => {
    const metadata = reviewDiffMetadata(
      { path: 'file.ts', status: 'modified', additions: 1, deletions: 1, binary: false },
      { patch: '@@ -1 +1 @@\n-old\n+new\n', truncated: false, binary: false },
      'file',
    )
    const extended = { ...metadata, libraryExtension: { retained: true } }
    const contract = codeProcessingWorkerContracts.process.output
    expect(Schema.is(contract)({ kind: 'metadata', metadata: extended })).toBe(true)
    expect(Schema.is(contract)({ kind: 'metadata', metadata: { ...metadata, isPartial: 'no' } })).toBe(false)
    expect(extended.libraryExtension).toEqual({ retained: true })
  })
})
