import { describe, expect, it } from 'vitest'

import { parseUnifiedDiff, splitDiffRows } from '../src/renderer/features/workspace/right-panel/unified-diff.js'

describe('split diff alignment', () => {
  it('pairs replacements and preserves line numbers through unbalanced changes', () => {
    const rows = splitDiffRows(
      parseUnifiedDiff('@@ -10,4 +20,5 @@\n same\n-old one\n-old two\n+new one\n+new two\n+new three\n trailing'),
    )
    expect(rows).toMatchObject([
      { kind: 'hunk' },
      { kind: 'lines', before: { oldNumber: 10 }, after: { newNumber: 20 } },
      { kind: 'lines', before: { oldNumber: 11, text: 'old one' }, after: { newNumber: 21, text: 'new one' } },
      { kind: 'lines', before: { oldNumber: 12, text: 'old two' }, after: { newNumber: 22, text: 'new two' } },
      { kind: 'lines', before: null, after: { newNumber: 23, text: 'new three' } },
      { kind: 'lines', before: { oldNumber: 13 }, after: { newNumber: 24 } },
    ])
  })

  it('does not pair changes across hunk boundaries and preserves newline notices', () => {
    const rows = splitDiffRows(
      parseUnifiedDiff('@@ -1 +1,0 @@\n-removed\n\\ No newline at end of file\n@@ -9,0 +10 @@\n+added'),
    )
    expect(rows).toMatchObject([
      { kind: 'hunk' },
      { kind: 'lines', before: { text: 'removed' }, after: null },
      { kind: 'note', text: '\\ No newline at end of file' },
      { kind: 'hunk' },
      { kind: 'lines', before: null, after: { text: 'added' } },
    ])
  })
})
