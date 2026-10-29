import { describe, expect, it } from 'vitest'

import { formatConverted, formatUsd } from '../src/renderer/shared/lib/currency.js'

const USD = { code: 'USD', symbol: '$', rate: 1 } as const
const EUR = { code: 'EUR', symbol: '€', rate: 0.9 } as const

describe('renderer currency-aware formatting (ADR 0009)', () => {
  it('formats raw USD using the supplied snapshot', () => {
    expect(formatUsd(12.34, USD)).toBe('$12.34')
    expect(formatUsd(1_234.5, USD)).toBe('$1,234.50')
  })

  it('converts USD figures through the supplied rate and symbol', () => {
    expect(formatUsd(100, EUR)).toBe('€90.00')
    expect(formatUsd(1_000, EUR)).toBe('€900.00')
  })

  it('formats an already-converted amount without applying the rate again', () => {
    expect(formatConverted(90, EUR)).toBe('€90.00')
  })

  it('does not share mutable active-currency state between calls', () => {
    expect(formatUsd(10, EUR)).toBe('€9.00')
    expect(formatUsd(10, USD)).toBe('$10.00')
  })

  it('falls back to zero for non-finite input', () => {
    expect(formatUsd(Number.NaN, EUR)).toBe('€0.00')
  })
})
