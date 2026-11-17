import { describe, expect, it } from 'vitest'

import { branchTriggerLabel } from '@/renderer/features/workspace/checkout-strip-state.js'
import { resolveAccessMode } from '@/renderer/features/workspace/model-picker/access-mode.js'
import { effortTitleFor } from '@/renderer/features/workspace/model-picker/catalog.js'

describe('effortTitleFor', () => {
  it('names reasoning levels effort and agent session modes mode', () => {
    expect(
      effortTitleFor([
        { id: 'low', label: 'Low' },
        { id: 'xhigh', label: 'Extra high' },
      ]),
    ).toBe('Effort')
    expect(
      effortTitleFor([
        { id: 'code', label: 'Code' },
        { id: 'plan', label: 'Plan' },
      ]),
    ).toBe('Mode')
    expect(effortTitleFor(null)).toBe('Effort')
  })
})

describe('resolveAccessMode', () => {
  it('lists only the modes the connection enforces, in a fixed order', () => {
    const resolved = resolveAccessMode('auto-accept-edits', [
      'full-access',
      'approval-required',
      'auto',
      'auto-accept-edits',
    ])
    expect(resolved.mode).toBe('auto-accept-edits')
    expect(resolved.options.map(option => option.label)).toEqual([
      'Supervised',
      'Auto-accept edits',
      'Auto',
      'Full access',
    ])
  })

  it('falls back to the first supported mode when the agent cannot enforce the chosen one', () => {
    expect(resolveAccessMode('full-access', ['approval-required']).mode).toBe('approval-required')
  })

  it('keeps the chosen mode and offers every mode until the agent reports its modes', () => {
    const resolved = resolveAccessMode('full-access', undefined)
    expect(resolved.mode).toBe('full-access')
    expect(resolved.options).toHaveLength(4)
  })
})

describe('branchTriggerLabel', () => {
  it('names the base of a new worktree and the checked-out branch otherwise', () => {
    expect(branchTriggerLabel('worktree', false, 'main')).toBe('From main')
    expect(branchTriggerLabel('worktree', true, 'watchtower/abcdef12')).toBe('watchtower/abcdef12')
    expect(branchTriggerLabel('local', false, 'feature')).toBe('feature')
    expect(branchTriggerLabel('local', false, null)).toBe('Detached HEAD')
  })
})
