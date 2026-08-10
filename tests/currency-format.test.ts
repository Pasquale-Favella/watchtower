import { afterEach, describe, expect, it } from 'vitest'
import {
  formatConverted, formatUsd, getActiveCurrency, setActiveCurrency,
} from '../src/renderer/src/shared/lib/currency.js'

const USD = { code: 'USD', symbol: '$', rate: 1 }
const EUR = { code: 'EUR', symbol: '€', rate: 0.9 }

afterEach(() => setActiveCurrency(USD))

describe('renderer currency-aware formatting (ADR 0009)', () => {
  it('formats raw USD with the default USD currency', () => {
    expect(formatUsd(12.34)).toBe('$12.34')
    expect(formatUsd(1_234.5)).toBe('$1,234.50')
  })

  it('converts USD figures through the active rate and swaps the symbol', () => {
    setActiveCurrency(EUR)
    expect(formatUsd(100)).toBe('€90.00')
    expect(formatUsd(1_000)).toBe('€900.00')
  })

  it('formatConverted swaps the symbol without re-applying the rate (already-converted values)', () => {
    setActiveCurrency(EUR)
    expect(formatConverted(90)).toBe('€90.00')
  })

  it('exposes the active currency for UI hints', () => {
    setActiveCurrency({ code: 'JPY', symbol: '¥', rate: 150 })
    expect(getActiveCurrency()).toEqual({ code: 'JPY', symbol: '¥', rate: 150 })
  })

  it('falls back to a zero figure for non-finite input instead of rendering NaN', () => {
    setActiveCurrency(EUR)
    expect(formatUsd(Number.NaN)).toBe('€0.00')
  })
})
