import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { browseDirectories } from '@/platform/electron/main/workspace/directory-browse.js'
import { displayShortcut, displayShortcutText } from '@/renderer/app/shortcuts'
import {
  ADD_ACTION_HINTS,
  ADD_ACTION_LABELS,
  appendBrowseSegment,
  browseAddAction,
  browseDirectoryOf,
  browseLeafOf,
  browseParentOf,
  browseTabAction,
  browseTabCompletion,
  cloneFolderName,
  filterBrowseEntries,
  isBrowsePath,
  isValidFolderName,
  PALETTE_BACK_HOTKEY,
  PALETTE_CLOSE_HOTKEY,
  PALETTE_COMPLETE_HOTKEY,
  PALETTE_FORCE_SUBMIT_HOTKEY,
  PALETTE_NEXT_HOTKEY,
  PALETTE_PREVIOUS_HOTKEY,
  PALETTE_SUBMIT_HOTKEY,
  paletteBackspaceGoesBack,
  paletteEnterIntent,
  paletteMoveTarget,
  projectSources,
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

  it('only claims Tab when there is something to complete or open', () => {
    const base = { browsing: true, hasActiveRow: false, hasDirectory: true, leaf: 'w' }
    expect(browseTabAction({ ...base, visible: [entry('watchtower')] })).toEqual({
      kind: 'descend',
      name: 'watchtower',
    })
    expect(browseTabAction({ ...base, visible: [entry('watch-a'), entry('Watch-b')] })).toEqual({
      kind: 'extend',
      name: 'watch-',
    })
    expect(browseTabAction({ ...base, hasActiveRow: true, visible: [entry('alpha'), entry('beta')] })).toEqual({
      kind: 'activate',
    })
    // Nothing to complete: Tab keeps moving focus, so it can reach the footer button.
    expect(browseTabAction({ ...base, leaf: '', visible: [entry('alpha'), entry('beta')] })).toBeNull()
    expect(browseTabAction({ ...base, visible: [] })).toBeNull()
    expect(browseTabAction({ ...base, hasDirectory: false, visible: [entry('watch-a'), entry('Watch-b')] })).toBeNull()
    expect(browseTabAction({ ...base, browsing: false, hasActiveRow: true, visible: [entry('watchtower')] })).toBeNull()
  })

  it('adds an existing folder as it is and creates a missing one, never running Git', () => {
    const missing = { exists: false }
    const folder = { exists: true }
    expect(browseAddAction('~/src/', folder, null)).toBe('add')
    expect(browseAddAction('~/src/', missing, null)).toBe('create')
    expect(browseAddAction('~/src/app', folder, entry('app'))).toBe('add')
    expect(browseAddAction('~/src/new', folder, null)).toBe('create')
    expect(Object.keys(ADD_ACTION_LABELS)).toEqual(['add', 'create'])
    expect(ADD_ACTION_LABELS).toEqual({ add: 'Add', create: 'Create & Add' })
    expect(ADD_ACTION_HINTS).toEqual({
      add: null,
      create: 'Press Enter to create this folder and add it as a project.',
    })
  })

  it('lists the sources in order with their copy', () => {
    expect(projectSources('ready').map(source => [source.id, source.title, source.description])).toEqual([
      ['new', 'New project', 'Start a new Git repository from a name'],
      ['local', 'Local folder', 'Browse a folder on disk'],
      ['git', 'Clone from Git URL', 'Clone from a remote URL'],
      ['github', 'Clone from GitHub', 'owner/repository through GitHub CLI'],
    ])
    expect(projectSources('unauthenticated')[3]?.description).toBe('Sign in first: run gh auth login')
    expect(projectSources('unavailable')[3]?.description).toBe('Requires GitHub CLI (gh)')
    expect(projectSources(null)[3]?.description).toBe('Checking GitHub CLI…')
  })

  it('submits on Enter unless a row is active, and on the modifier with Enter regardless', () => {
    const typed = { hasSubmit: true, submitDisabled: false }
    expect(paletteEnterIntent({ ...typed, forceSubmit: false, hasActiveRow: false })).toBe('submit')
    expect(paletteEnterIntent({ ...typed, forceSubmit: false, hasActiveRow: true })).toBe('activate')
    expect(paletteEnterIntent({ ...typed, forceSubmit: true, hasActiveRow: true })).toBe('submit')
    expect(paletteEnterIntent({ ...typed, submitDisabled: true, forceSubmit: true, hasActiveRow: true })).toBe('none')
    expect(paletteEnterIntent({ ...typed, submitDisabled: true, forceSubmit: false, hasActiveRow: false })).toBe('none')
    const listOnly = { hasSubmit: false, submitDisabled: true }
    expect(paletteEnterIntent({ ...listOnly, forceSubmit: false, hasActiveRow: true })).toBe('activate')
    expect(paletteEnterIntent({ ...listOnly, forceSubmit: true, hasActiveRow: true })).toBe('activate')
    expect(paletteEnterIntent({ ...listOnly, forceSubmit: false, hasActiveRow: false })).toBe('none')
  })

  it('moves the highlight with the arrows and wraps at both ends', () => {
    const ids = ['a', 'b', 'c']
    expect(paletteMoveTarget(ids, null, 1)).toBe('a')
    expect(paletteMoveTarget(ids, null, -1)).toBe('c')
    expect(paletteMoveTarget(ids, 'a', 1)).toBe('b')
    expect(paletteMoveTarget(ids, 'c', 1)).toBe('a')
    expect(paletteMoveTarget(ids, 'a', -1)).toBe('c')
    expect(paletteMoveTarget(ids, 'gone', 1)).toBe('a')
    expect(paletteMoveTarget([], null, 1)).toBeNull()
  })

  it('goes back on Backspace only from an empty input and not on a held key', () => {
    expect(paletteBackspaceGoesBack({ value: '', repeat: false })).toBe(true)
    expect(paletteBackspaceGoesBack({ value: '', repeat: true })).toBe(false)
    expect(paletteBackspaceGoesBack({ value: 'a', repeat: false })).toBe(false)
  })

  it('labels the palette keys per platform', () => {
    const labels = (platform: 'mac' | 'windows') => [
      displayShortcut(PALETTE_PREVIOUS_HOTKEY, platform),
      displayShortcut(PALETTE_NEXT_HOTKEY, platform),
      displayShortcutText(PALETTE_SUBMIT_HOTKEY, platform),
      displayShortcutText(PALETTE_FORCE_SUBMIT_HOTKEY, platform),
      displayShortcutText(PALETTE_COMPLETE_HOTKEY, platform),
      displayShortcutText(PALETTE_BACK_HOTKEY, platform),
      displayShortcutText(PALETTE_CLOSE_HOTKEY, platform),
    ]
    expect(labels('windows')).toEqual(['↑', '↓', 'Enter', 'Ctrl+Enter', 'Tab', 'Backspace', 'Escape'])
    expect(labels('mac')[3]).toBe('⌘↵')
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
