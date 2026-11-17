import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { browseDirectories } from '@/platform/electron/main/workspace/directory-browse.js'
import {
  appendBrowseSegment,
  browseAddAction,
  browseDirectoryOf,
  browseLeafOf,
  browseParentOf,
  browseTabCompletion,
  cloneFolderName,
  filterBrowseEntries,
  isBrowsePath,
  isValidFolderName,
  resolveBrowseTarget,
} from '@/renderer/features/workspace/project-browse-state.js'

const entry = (name: string) => ({ name, fullPath: `C:\\src\\${name}` })

describe('project browse paths', () => {
  it.each([
    ['C:\\src\\app', 'C:\\src\\', 'app', 'C:\\src\\x\\'],
    ['/home/me/', '/home/me/', '', '/home/me/x/'],
    ['~/projects/wat', '~/projects/', 'wat', '~/projects/x/'],
    ['\\\\server\\share\\repo', '\\\\server\\share\\', 'repo', '\\\\server\\share\\x\\'],
  ])('splits %s into directory and leaf', (query, directory, leaf, appended) => {
    expect(isBrowsePath(query)).toBe(true)
    expect(browseDirectoryOf(query)).toBe(directory)
    expect(browseLeafOf(query)).toBe(leaf)
    expect(appendBrowseSegment(directory, 'x')).toBe(appended)
  })

  it('rejects relative and drive-less input', () => {
    expect(isBrowsePath('projects/app')).toBe(false)
    expect(isBrowsePath('C:')).toBe(false)
    expect(isBrowsePath('')).toBe(false)
  })

  it.each([
    ['C:\\src\\app\\', 'C:\\src\\'],
    ['C:\\src\\', 'C:\\'],
    ['C:\\', null],
    ['/home/me/', '/home/'],
    ['/', null],
    ['~/projects/', '~/'],
    ['~/', null],
    ['\\\\server\\share\\', null],
  ])('goes up from %s', (directory, parent) => {
    expect(browseParentOf(directory)).toBe(parent)
  })

  it('hides dot folders unless the leaf asks for them', () => {
    const entries = [entry('.git'), entry('app'), entry('Api')]
    expect(filterBrowseEntries(entries, '').visible.map(item => item.name)).toEqual(['app', 'Api'])
    expect(filterBrowseEntries(entries, 'a').visible.map(item => item.name)).toEqual(['app', 'Api'])
    expect(filterBrowseEntries(entries, '.').visible.map(item => item.name)).toEqual(['.git'])
    expect(filterBrowseEntries(entries, 'app').exact?.name).toBe('app')
  })

  it('completes Tab like a shell', () => {
    expect(browseTabCompletion([entry('watchtower')], 'w')).toEqual({ name: 'watchtower', complete: true })
    expect(browseTabCompletion([entry('watch-a'), entry('Watch-b')], 'w')).toEqual({ name: 'watch-', complete: false })
    expect(browseTabCompletion([entry('alpha'), entry('beta')], '')).toBeNull()
    expect(browseTabCompletion([], 'x')).toBeNull()
  })

  it('picks the add action from what exists at the target', () => {
    const missing = { exists: false, isRepository: false }
    const folder = { exists: true, isRepository: false }
    const repository = { exists: true, isRepository: true }
    expect(browseAddAction('~/src/', repository, null)).toBe('add')
    expect(browseAddAction('~/src/', folder, null)).toBe('init')
    expect(browseAddAction('~/src/', missing, null)).toBe('create')
    expect(browseAddAction('~/src/app', folder, { isRepository: true })).toBe('add')
    expect(browseAddAction('~/src/app', folder, { isRepository: false })).toBe('init')
    expect(browseAddAction('~/src/new', repository, null)).toBe('create')
  })

  it.each([
    ['https://github.com/owner/repo.git', 'repo'],
    ['git@github.com:owner/repo.git', 'repo'],
    ['owner/Repo', 'Repo'],
    ['C:\\src\\remote\\', 'remote'],
  ])('names the clone folder for %s', (source, folder) => {
    expect(cloneFolderName(source)).toBe(folder)
  })

  it('accepts only plain folder names for new projects', () => {
    expect(isValidFolderName('my-app')).toBe(true)
    expect(isValidFolderName('a/b')).toBe(false)
    expect(isValidFolderName('..')).toBe(false)
    expect(isValidFolderName(' padded')).toBe(false)
  })

  it('resolves the folder Enter adds', () => {
    expect(resolveBrowseTarget('~/src/', 'C:\\Users\\me\\src', null)).toBe('C:\\Users\\me\\src')
    expect(resolveBrowseTarget('~/src/app', 'C:\\Users\\me\\src', entry('app'))).toBe('C:\\src\\app')
    expect(resolveBrowseTarget('~/src/new', 'C:\\Users\\me\\src', null)).toBe('C:\\Users\\me\\src\\new')
    expect(resolveBrowseTarget('/new', '/', null)).toBe('/new')
  })
})

describe('browseDirectories', () => {
  it('lists sorted subfolders under an expanded home and treats missing folders as empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'watchtower-browse-'))
    try {
      mkdirSync(join(home, 'zeta'))
      mkdirSync(join(home, 'alpha', '.git'), { recursive: true })
      writeFileSync(join(home, 'file.txt'), '')
      const listing = await browseDirectories('~/', home)
      expect(listing).toEqual({
        parentPath: home,
        exists: true,
        isRepository: false,
        entries: [
          { name: 'alpha', fullPath: join(home, 'alpha'), isRepository: true },
          { name: 'zeta', fullPath: join(home, 'zeta'), isRepository: false },
        ],
      })
      expect(await browseDirectories(join(home, 'missing'), home)).toMatchObject({ exists: false, entries: [] })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
