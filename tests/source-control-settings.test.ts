import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  selectSettingsGroupAtom,
  selectSettingsPaneAtom,
  settingsDialogAtom,
} from '@/renderer/features/settings/dialog-atoms.js'
import { SETTINGS_PANES } from '@/renderer/features/settings/dialog-navigation.js'
import {
  effectiveMergeMethod,
  githubSummary,
  githubTone,
  gitSummary,
  gitTone,
  isAccountRevealed,
} from '@/renderer/features/settings/source-control-state.js'
import { projectSources } from '@/renderer/features/workspace/project-browse-state.js'
import {
  decodeSourceControlPreferences,
  DEFAULT_SOURCE_CONTROL_PREFERENCES,
} from '@/renderer/features/workspace/source-control-preferences.js'

describe('source control preferences', () => {
  it('defaults to offering GitHub and squash merges', () => {
    expect(DEFAULT_SOURCE_CONTROL_PREFERENCES).toEqual({ githubOffered: true, mergeMethod: 'squash' })
  })

  it('returns nothing for missing, unreadable or mis-shaped storage', () => {
    expect(decodeSourceControlPreferences(null)).toBeNull()
    expect(decodeSourceControlPreferences('{nope')).toBeNull()
    expect(decodeSourceControlPreferences(JSON.stringify({ githubOffered: 'yes' }))).toBeNull()
    expect(decodeSourceControlPreferences(JSON.stringify({ mergeMethod: 'fast-forward' }))).toBeNull()
  })

  it('fills fields an older build did not store with their defaults', () => {
    expect(decodeSourceControlPreferences(JSON.stringify({ githubOffered: false }))).toEqual({
      githubOffered: false,
      mergeMethod: 'squash',
    })
    expect(decodeSourceControlPreferences(JSON.stringify({ mergeMethod: 'rebase' }))).toEqual({
      githubOffered: true,
      mergeMethod: 'rebase',
    })
  })
})

describe('add-project sources when GitHub is not offered', () => {
  it('lists GitHub by default and drops only it when switched off', () => {
    expect(projectSources('ready').map(source => source.id)).toEqual(['new', 'local', 'git', 'github'])
    expect(projectSources('ready', true).map(source => source.id)).toEqual(['new', 'local', 'git', 'github'])
    expect(projectSources('ready', false).map(source => source.id)).toEqual(['new', 'local', 'git'])
    expect(projectSources(null, false).map(source => source.id)).toEqual(['new', 'local', 'git'])
  })
})

describe('source control status copy', () => {
  it('describes Git', () => {
    expect(gitSummary({ available: true })).toBe('Available')
    expect(gitSummary({ available: false })).toBe('Not available: install Git and rescan.')
    expect([gitTone(null), gitTone({ available: true }), gitTone({ available: false })]).toEqual([
      'checking',
      'available',
      'unavailable',
    ])
  })

  it('describes GitHub without revealing the account', () => {
    expect(githubSummary('ready')).toBe('Authenticated')
    expect(githubSummary('unauthenticated')).toContain('gh auth login')
    expect(githubSummary('unavailable')).toBe('Requires GitHub CLI (gh).')
    expect([githubTone('ready'), githubTone('unauthenticated'), githubTone('unavailable'), githubTone(null)]).toEqual([
      'available',
      'unavailable',
      'unavailable',
      'checking',
    ])
  })
})

describe('account reveal', () => {
  it('stays hidden until an account is revealed', () => {
    expect(isAccountRevealed(null, 'octocat')).toBe(false)
    expect(isAccountRevealed(null, null)).toBe(false)
  })

  it('shows the account that was revealed', () => {
    expect(isAccountRevealed('octocat', 'octocat')).toBe(true)
  })

  it('hides again when the account changes or disappears', () => {
    expect(isAccountRevealed('octocat', 'hubot')).toBe(false)
    expect(isAccountRevealed('octocat', null)).toBe(false)
  })
})

describe('merge dialog default', () => {
  it('starts from the configured default and follows it when changed in settings', () => {
    expect(effectiveMergeMethod(null, 'squash')).toBe('squash')
    expect(effectiveMergeMethod(null, 'rebase')).toBe('rebase')
  })

  it('lets a selection made in the open dialog win; a reopened dialog has no selection', () => {
    expect(effectiveMergeMethod('merge', 'squash')).toBe('merge')
    // The dialog is mounted only while open, so its selection state starts as null on every open.
    expect(effectiveMergeMethod(null, 'squash')).toBe('squash')
  })
})

describe('settings navigation', () => {
  it('lists Source control in the Workspace group and can select it', () => {
    expect(SETTINGS_PANES.workspace.map(pane => pane.id)).toContain('source-control')
    expect(SETTINGS_PANES.workspace.find(pane => pane.id === 'source-control')?.label).toBe('Source control')
    const registry = AtomRegistry.make()
    registry.set(selectSettingsGroupAtom, 'workspace')
    registry.set(selectSettingsPaneAtom, 'source-control')
    expect(registry.get(settingsDialogAtom).pane).toBe('source-control')
    registry.dispose()
  })
})
