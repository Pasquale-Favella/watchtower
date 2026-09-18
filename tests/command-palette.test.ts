import { describe, expect, it } from 'vitest'

import { shortcutForAction } from '../src/renderer/src/app/shortcuts.js'
import { PALETTE_ACTIONS, PALETTE_SECTIONS, PALETTE_ROWS, rowFilterValue } from '../src/renderer/src/app/components/CommandPalette.js'

describe('command palette rows (ADR 0028)', () => {
  it('lists every section plus refresh/toggleSidebar — and never itself', () => {
    expect(PALETTE_SECTIONS).toHaveLength(9)
    expect([...PALETTE_ACTIONS]).toEqual(['refresh', 'toggleSidebar'])
    expect([...PALETTE_SECTIONS, ...PALETTE_ACTIONS]).not.toContain('commandPalette')
  })

  it('every row carries an explicit section|action source (spec §What to build)', () => {
    expect(PALETTE_ROWS).toHaveLength(PALETTE_SECTIONS.length + PALETTE_ACTIONS.length)
    expect(PALETTE_ROWS.filter(row => row.source === 'section').map(row => row.action)).toEqual([...PALETTE_SECTIONS])
    expect(PALETTE_ROWS.filter(row => row.source === 'action').map(row => row.action)).toEqual([...PALETTE_ACTIONS])
  })

  it('filter values carry label plus registry id', () => {
    expect(rowFilterValue({ action: 'pullRequests', source: 'section' })).toBe('Pull requests pullRequests')
    for (const row of PALETTE_ROWS) {
      expect(rowFilterValue(row)).toContain(row.action)
    }
  })
  it('every row resolves a registry label (unique filter values for cmdk)', () => {
    const labels = [...PALETTE_SECTIONS, ...PALETTE_ACTIONS].map(
      action => shortcutForAction(action)?.label ?? action,
    )
    expect(labels.every(Boolean)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
