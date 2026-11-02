import { describe, expect, it } from 'vitest'

import { buildDiffTree, diffFileKey, folderPaths } from '@/renderer/features/workspace/right-panel/diff-tree.js'
import {
  browserStorage,
  checkoutScope,
  clampRightPanelWidth,
  readRightPanelPreferences,
  readRightPanelWidth,
  RIGHT_PANEL_DEFAULT_WIDTH,
  writeRightPanelPreferences,
} from '@/renderer/features/workspace/right-panel/right-panel-state.js'
import { formatCompactCount, parseUnifiedDiff } from '@/renderer/features/workspace/right-panel/unified-diff.js'
import type { DiffFile } from '@/shared/schemas/checkout-inspection.js'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size
    },
  } as unknown as Storage
}

const file = (path: string, additions: number, deletions: number): DiffFile => ({
  path,
  status: 'modified',
  additions,
  deletions,
  binary: false,
})

describe('unified diff parser', () => {
  it('numbers old and new lines across hunks and counts changed lines', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' export {}',
      '@@ -20 +21 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(patch)
    expect(parsed.additions).toBe(3)
    expect(parsed.deletions).toBe(2)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0].header).toBe('@@ -1,3 +1,4 @@')
    expect(parsed.hunks[0].lines).toEqual([
      { kind: 'context', text: 'const a = 1', oldNumber: 1, newNumber: 1 },
      { kind: 'deletion', text: 'const b = 2', oldNumber: 2, newNumber: null },
      { kind: 'addition', text: 'const b = 3', oldNumber: null, newNumber: 2 },
      { kind: 'addition', text: 'const c = 4', oldNumber: null, newNumber: 3 },
      { kind: 'context', text: 'export {}', oldNumber: 3, newNumber: 4 },
    ])
    expect(parsed.hunks[1].lines).toEqual([
      { kind: 'deletion', text: 'old', oldNumber: 20, newNumber: null },
      { kind: 'addition', text: 'new', oldNumber: null, newNumber: 21 },
      { kind: 'note', text: '\\ No newline at end of file', oldNumber: null, newNumber: null },
    ])
  })

  it('ignores metadata-only patches such as pure renames', () => {
    const patch = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n')
    expect(parseUnifiedDiff(patch)).toEqual({ hunks: [], additions: 0, deletions: 0 })
  })

  it('does not count a file header that follows a hunk as a deletion', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b', 'diff --git a/next.ts b/next.ts', '--- a/next.ts'].join('\n')
    expect(parseUnifiedDiff(patch).deletions).toBe(1)
  })

  it('formats compact counts without losing the exact value in accessible text', () => {
    expect(formatCompactCount(0)).toBe('0')
    expect(formatCompactCount(950)).toBe('950')
    expect(formatCompactCount(1000)).toBe('1k')
    expect(formatCompactCount(1200)).toBe('1.2k')
    expect(formatCompactCount(15400)).toBe('15k')
  })
})

describe('changed-file tree', () => {
  it('groups by folder with folders before files and aggregates counts', () => {
    const tree = buildDiffTree([
      file('src/a.ts', 1, 0),
      file('src/nested/b.ts', 2, 1),
      file('README.md', 0, 0),
      file('lib/c.ts', 4, 4),
    ])
    expect(tree.map(node => [node.kind, node.name])).toEqual([
      ['folder', 'lib'],
      ['folder', 'src'],
      ['file', 'README.md'],
    ])
    const src = tree[1]
    expect(src).toMatchObject({ kind: 'folder', additions: 3, deletions: 1, path: 'src' })
    if (src.kind !== 'folder') throw new Error('expected a folder')
    expect(src.children.map(node => [node.kind, node.name])).toEqual([
      ['folder', 'nested'],
      ['file', 'a.ts'],
    ])
    expect(folderPaths(tree)).toEqual(['lib', 'src', 'src/nested'])
  })

  it('keeps renames addressable by both paths', () => {
    expect(diffFileKey({ path: 'new.ts', previousPath: 'old.ts' })).toBe('old.ts -> new.ts')
    expect(diffFileKey({ path: 'plain.ts' })).toBe('plain.ts')
  })
})

describe('right panel state', () => {
  it('clamps width between the minimum and the smaller of 70% of the viewport and the chat reserve', () => {
    expect(clampRightPanelWidth(100, 1440, 1200)).toBe(360)
    expect(clampRightPanelWidth(900, 1000, 1200)).toBe(700)
    expect(clampRightPanelWidth(2000, 1440, 1200)).toBe(840)
    expect(clampRightPanelWidth(500, 1440, 700)).toBe(360)
  })

  it('falls back to defaults for missing or malformed storage', () => {
    expect(readRightPanelPreferences(null)).toEqual({})
    expect(readRightPanelPreferences(memoryStorage({ 'watchtower.workspace.right-panel.v1': '{not json' }))).toEqual({})
    expect(
      readRightPanelPreferences(
        memoryStorage({ 'watchtower.workspace.right-panel.v1': '{"task-1":{"open":true,"tab":"files"}}' }),
      ),
    ).toEqual({ 'task-1': { open: true, tab: 'files' } })
    expect(readRightPanelWidth(memoryStorage({ 'watchtower.workspace.right-panel-width.v1': 'wide' }))).toBe(
      RIGHT_PANEL_DEFAULT_WIDTH,
    )
    expect(readRightPanelWidth(null)).toBe(RIGHT_PANEL_DEFAULT_WIDTH)
  })

  it('bounds remembered panels to the most recent entries', () => {
    const storage = memoryStorage()
    const preferences = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`task-${index}`, { open: true, tab: 'diff' as const }]),
    )
    writeRightPanelPreferences(storage, preferences)
    const stored = readRightPanelPreferences(storage)
    expect(Object.keys(stored)).toHaveLength(100)
    expect(stored).toHaveProperty('task-149')
    expect(stored).not.toHaveProperty('task-0')
  })

  it('omits the checkout key when the Project main checkout is used', () => {
    expect(checkoutScope('project-1' as never, undefined)).toEqual({ projectId: 'project-1' })
    expect(Object.keys(checkoutScope('project-1' as never, undefined))).not.toContain('checkoutId')
    expect(browserStorage()).toBeNull()
  })
})
