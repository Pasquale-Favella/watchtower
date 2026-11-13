import { describe, expect, it } from 'vitest'

import { diffBranchChoices } from '../src/renderer/features/workspace/right-panel/diff-branch-choices.js'
import { reviewDiffMetadata } from '../src/renderer/features/workspace/right-panel/diff-review-model.js'
import {
  collapsedDiffFileKeys,
  DEFAULT_DIFF_PREFERENCES,
  DIFF_EXPANDED_KEY,
  DIFF_PREFERENCES_KEY,
  diffReviewSectionId,
  isTestDiffPath,
  readDiffPreferences,
  readDiffReviewSection,
  readExpandedDiffs,
  resolvedDiffSelector,
  shownDiffFiles,
  writeExpandedDiffs,
} from '../src/renderer/features/workspace/right-panel/diff-review-state.js'
import { diffTreePresentation } from '../src/renderer/features/workspace/right-panel/diff-review-tree.js'
import type { CheckoutScope, DiffFile, DiffSource } from '../src/shared/schemas/checkout-inspection.js'

function file(path: string, status: DiffFile['status'] = 'modified'): DiffFile {
  return { path, status, additions: 1, deletions: 1, binary: false }
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('diff review files', () => {
  it('keeps full unchanged context available while preserving the Git patch hunks', () => {
    const oldContent = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
    const newContent = 'one\ntwo\nthree\nchanged\nfive\nsix\nseven\n'
    const metadata = reviewDiffMetadata(
      file('src/example.ts'),
      {
        patch:
          'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -3,3 +3,3 @@\n three\n-four\n+changed\n five\n',
        oldContent,
        newContent,
        truncated: false,
        binary: false,
      },
      'fixture',
    )
    expect(metadata.isPartial).toBe(false)
    expect(metadata.deletionLines.join('')).toBe(oldContent)
    expect(metadata.additionLines.join('')).toBe(newContent)
    expect(metadata.hunks).toHaveLength(1)
    expect(metadata.hunks[0]).toMatchObject({ additionStart: 3, deletionStart: 3 })
  })

  it('keeps a truncated patch partial even when content fields are supplied', () => {
    const metadata = reviewDiffMetadata(
      file('example.ts'),
      {
        patch: 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
        oldContent: 'old\n',
        newContent: 'new\n',
        truncated: true,
        binary: false,
      },
      'fixture',
    )
    expect(metadata.isPartial).toBe(true)
  })

  it('retains rename paths and binary/deleted identities without fabricated code rows', () => {
    const metadata = reviewDiffMetadata(
      { ...file('new.png', 'renamed'), previousPath: 'old.png', binary: true },
      { binary: true, truncated: false, patch: '' },
      'binary',
    )
    expect(metadata).toMatchObject({ name: 'new.png', prevName: 'old.png', type: 'rename-pure', hunks: [] })
    expect(reviewDiffMetadata(file('removed.ts', 'deleted'), undefined, 'pending').type).toBe('deleted')
  })

  it('hides test files and retains an explicitly revealed test file', () => {
    const files = [
      file('src/main.ts'),
      file('src/main.test.ts'),
      file('tests/integration.ts'),
      file('fixtures/data.json'),
    ]
    expect(shownDiffFiles(files, true, null).map(item => item.path)).toEqual(['src/main.ts'])
    expect(shownDiffFiles(files, true, 'src/main.test.ts').map(item => item.path)).toEqual([
      'src/main.ts',
      'src/main.test.ts',
    ])
    expect(isTestDiffPath('src/contest.ts')).toBe(false)
    expect(isTestDiffPath('src/component.spec.tsx')).toBe(true)
    expect(isTestDiffPath('src/tests/generated/models.ts')).toBe(false)
    expect(isTestDiffPath('services/test_handlers.py')).toBe(true)
    expect(isTestDiffPath('src/HandlersTest.java')).toBe(true)
    expect(isTestDiffPath('src/Latest.java')).toBe(false)
    expect(isTestDiffPath('snapshots/output.snap')).toBe(true)
  })
})

describe('diff review preferences', () => {
  it('recovers from corrupt storage and validates every preference', () => {
    const storage = memoryStorage()
    storage.setItem(DIFF_PREFERENCES_KEY, '{broken')
    expect(readDiffPreferences(storage)).toEqual(DEFAULT_DIFF_PREFERENCES)
    storage.setItem(
      DIFF_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_DIFF_PREFERENCES, layout: 'unified', wrap: true }),
    )
    expect(readDiffPreferences(storage)).toMatchObject({ layout: 'unified', wrap: true })
    storage.setItem(DIFF_PREFERENCES_KEY, JSON.stringify({ ...DEFAULT_DIFF_PREFERENCES, layout: 'invalid' }))
    expect(readDiffPreferences(storage)).toEqual(DEFAULT_DIFF_PREFERENCES)
  })

  it('starts files collapsed and preserves explicitly expanded files when new changes arrive', () => {
    const storage = memoryStorage()
    const files = [file('first.ts'), file('second.ts')]
    expect([...collapsedDiffFileKeys(files, readExpandedDiffs(storage, 'checkout'))]).toEqual(['first.ts', 'second.ts'])
    writeExpandedDiffs(storage, 'checkout', new Set(['first.ts']))
    expect([...collapsedDiffFileKeys([...files, file('new.ts')], readExpandedDiffs(storage, 'checkout'))]).toEqual([
      'second.ts',
      'new.ts',
    ])
  })

  it('scopes expanded paths and retains at most 100 comparisons', () => {
    const storage = memoryStorage()
    writeExpandedDiffs(storage, 'checkout-A', new Set(['file.ts']))
    expect([...readExpandedDiffs(storage, 'checkout-A')]).toEqual(['file.ts'])
    expect([...readExpandedDiffs(storage, 'checkout-B')]).toEqual([])
    for (let index = 0; index < 105; index++) writeExpandedDiffs(storage, `source-${index}`, new Set(['another.ts']))
    expect(Object.keys(JSON.parse(storage.getItem(DIFF_EXPANDED_KEY) ?? '{}'))).toHaveLength(100)
    expect([...readExpandedDiffs(storage, 'checkout-A')]).toEqual([])
  })

  it('repeats resolved commit comparisons and restores their annotation source', () => {
    const scope = { projectId: 'project-fixture' as CheckoutScope['projectId'] }
    const source: DiffSource = {
      id: 'commit-fixture',
      kind: 'commit',
      title: 'Commit',
      baseRef: 'base',
      headRef: 'resolved-sha',
      files: [],
      truncated: false,
    }
    expect(resolvedDiffSelector(source, true)).toEqual({
      kind: 'commit',
      commit: 'resolved-sha',
      ignoreWhitespace: true,
    })
    const section = readDiffReviewSection(diffReviewSectionId(scope, source, true))
    expect(section).toMatchObject({ scope, source: { kind: 'commit', commit: 'resolved-sha', ignoreWhitespace: true } })
    expect(readDiffReviewSection('{invalid')).toBeNull()
  })
})

describe('diff tree path presentation', () => {
  it('keeps removed files distinct from directories created at the same path', () => {
    const model = diffTreePresentation(['old', 'old/new.ts', 'other/old\u200b'])
    const alias = model.modelPath('old')
    expect(alias).not.toBe('old')
    expect(alias).not.toBe('old\u200b')
    expect(model.selectionPath(alias)).toBe('old')
    expect(model.modelPath('old/new.ts')).toBe('old/new.ts')
    expect(model.directories).toEqual(['old/', 'other/'])
  })
})

describe('branch comparison choices', () => {
  it('pairs local and remote branches and keeps additional remotes selectable', () => {
    expect(
      diffBranchChoices([
        { name: 'main', kind: 'local', current: true },
        { name: 'origin/main', kind: 'remote', current: false },
        { name: 'upstream/main', kind: 'remote', current: false },
        { name: 'origin/feature/nested', kind: 'remote', current: false },
      ]),
    ).toEqual([
      { label: 'feature/nested', local: null, remote: 'origin/feature/nested' },
      { label: 'main', local: 'main', remote: 'origin/main' },
      { label: 'upstream/main', local: null, remote: 'upstream/main' },
    ])
  })
})
