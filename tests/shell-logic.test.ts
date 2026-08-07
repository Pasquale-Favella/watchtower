import { describe, expect, it } from 'vitest'
import {
  providerOptionsFromDetected,
  buildScopeCaption,
  resolveThemeMode,
  themeIsDark,
  CADENCE_UI_OPTIONS
} from '../src/renderer/src/shared/lib/shell.js'

describe('providerOptionsFromDetected', () => {
  it('always includes "All providers" first', () => {
    const options = providerOptionsFromDetected([])
    expect(options).toEqual([{ value: 'all', label: 'All providers' }])
  })

  it('lists only detected providers, deduplicated and title-cased', () => {
    const options = providerOptionsFromDetected(['claude', 'claude', 'opencode'])
    expect(options).toEqual([
      { value: 'all', label: 'All providers' },
      { value: 'claude', label: 'Claude' },
      { value: 'opencode', label: 'Opencode' }
    ])
  })

  it('never invents a provider that was not detected', () => {
    const options = providerOptionsFromDetected(['cursor'])
    expect(options.some(o => o.value === 'antigravity')).toBe(false)
  })
})

describe('buildScopeCaption', () => {
  it('joins the period and provider labels with a middle dot', () => {
    expect(buildScopeCaption('Today', 'All providers')).toBe('Today · All providers')
    expect(buildScopeCaption('Last 7 days', 'Claude')).toBe('Last 7 days · Claude')
  })

  it('appends the config label when one is given', () => {
    expect(buildScopeCaption('Today', 'All providers', 'default')).toBe('Today · All providers · default')
  })
})

describe('resolveThemeMode', () => {
  it('prefers an explicit saved preference (system/light/dark)', () => {
    expect(resolveThemeMode('dark')).toBe('dark')
    expect(resolveThemeMode('light')).toBe('light')
    expect(resolveThemeMode('system')).toBe('system')
  })

  it('defaults to system (OS-following) when nothing or an invalid value is saved', () => {
    expect(resolveThemeMode(null)).toBe('system')
    expect(resolveThemeMode('')).toBe('system')
    expect(resolveThemeMode('sepia')).toBe('system')
  })
})

describe('themeIsDark', () => {
  it('light and dark force the resolved value; system follows the OS', () => {
    expect(themeIsDark('light', true)).toBe(false)
    expect(themeIsDark('dark', false)).toBe(true)
    expect(themeIsDark('system', true)).toBe(true)
    expect(themeIsDark('system', false)).toBe(false)
  })
})

describe('CADENCE_UI_OPTIONS (kept in sync with main/cadence.ts by hand)', () => {
  it('matches the main process cadence module\'s values exactly, so the Settings dropdown never drifts from what cadence:set accepts', async () => {
    const { CADENCE_OPTIONS } = await import('../src/main/cadence.js')
    expect(CADENCE_UI_OPTIONS.map(o => o.value)).toEqual(CADENCE_OPTIONS.map(o => o.value))
  })
})
