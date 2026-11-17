import { describe, expect, it } from 'vitest'

import {
  applicableFileTreeUpdates,
  buildFileTreePaths,
  buildFileTreePathUpdates,
} from '../src/renderer/features/workspace/right-panel/file-tree-paths.js'

describe('buildFileTreePaths', () => {
  it('lists the directories a search result implies, so the tree never infers them', () => {
    expect(buildFileTreePaths(['packages/', 'packages/deep/src/module.ts'])).toEqual([
      'packages/',
      'packages/deep/',
      'packages/deep/src/',
      'packages/deep/src/module.ts',
    ])
  })

  it('keeps each path once when listings and search disagree about its kind', () => {
    expect(buildFileTreePaths(['packages/deep/', 'packages/deep', 'src/index.ts'])).toEqual([
      'packages/',
      'packages/deep/',
      'src/',
      'src/index.ts',
    ])
  })

  it('scopes ancestor inference to the browsed folder', () => {
    expect(buildFileTreePaths(['packages/deep/src/module.ts', 'lib/helper.ts'], 'packages')).toEqual([
      'packages/deep/',
      'packages/deep/src/',
      'packages/deep/src/module.ts',
    ])
  })
})

describe('buildFileTreePathUpdates', () => {
  it('adds parents before children', () => {
    expect(buildFileTreePathUpdates(['src/'], ['src/', 'src/a/', 'src/a/b.ts'])).toEqual([
      { type: 'add', path: 'src/a/' },
      { type: 'add', path: 'src/a/b.ts' },
    ])
  })

  it('removes a folder once, after its children, and skips the paths inside it', () => {
    expect(buildFileTreePathUpdates(['src/', 'src/a/', 'src/a/b/', 'src/a/c.ts'], ['src/'])).toEqual([
      { type: 'remove', path: 'src/a/', recursive: true },
    ])
  })

  it('does not treat a sibling that shares a name prefix as inside a removed folder', () => {
    expect(buildFileTreePathUpdates(['src/a/', 'src/ab/', 'src/a.ts'], [])).toEqual([
      { type: 'remove', path: 'src/a/', recursive: true },
      { type: 'remove', path: 'src/ab/', recursive: true },
      { type: 'remove', path: 'src/a.ts' },
    ])
  })
})

it('drops operations the model already disagrees with', () => {
  const updates = buildFileTreePathUpdates(['src/'], ['src/', 'lib/', 'lib/helper.ts'])
  const paths = new Set(['src/', 'lib/'])
  expect(
    applicableFileTreeUpdates(updates, path => paths.has(path)).map(update =>
      update.type === 'move' ? `move:${update.from}` : `${update.type}:${update.path}`,
    ),
  ).toEqual(['add:lib/helper.ts'])
})
