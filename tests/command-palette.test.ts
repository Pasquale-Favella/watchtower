import { describe, expect, it } from 'vitest'

import { shortcutForAction } from '../src/renderer/src/app/shortcuts.js'
import { PALETTE_ACTIONS, PALETTE_SECTIONS } from '../src/renderer/src/app/components/CommandPalette.js'

describe('command palette rows (ADR 0028)', () => {
  it('lists every section plus refresh/toggleSidebar — and never itself', () => {
    expect(PALETTE_SECTIONS).toHaveLength(9)
    expect([...PALETTE_ACTIONS]).toEqual(['refresh', 'toggleSidebar'])
    expect([...PALETTE_SECTIONS, ...PALETTE_ACTIONS]).not.toContain('commandPalette')
  })

  it('every row resolves a registry label (unique filter values for cmdk)', () => {
    const labels = [...PALETTE_SECTIONS, ...PALETTE_ACTIONS].map(
      action => shortcutForAction(action)?.label ?? action,
    )
    expect(labels.every(Boolean)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
