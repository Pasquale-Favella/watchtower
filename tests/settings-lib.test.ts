import { describe, expect, it } from 'vitest'
import { DEFAULT_PERIOD_VALUES } from '../src/renderer/src/shared/lib/settings-constants'
import {
  formatBytes,
  parseRate,
  readStoredDefaultPeriod,
  writeStoredDefaultPeriod,
  validatePricing,
} from '../src/renderer/src/features/settings/lib'

class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

describe('formatBytes (Settings › Privacy & data)', () => {
  it('formats byte magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

describe('parseRate (Settings › Pricing input parsing)', () => {
  it('returns undefined for an empty string (field not provided)', () => {
    expect(parseRate('')).toBeUndefined()
    expect(parseRate('   ')).toBeUndefined()
  })

  it('returns the positive finite number for a valid rate', () => {
    expect(parseRate('3')).toBe(3)
    expect(parseRate('3.5')).toBe(3.5)
    expect(parseRate(' 15 ')).toBe(15)
  })

  it("returns 'invalid' for zero, negative, non-numeric, and non-finite input", () => {
    expect(parseRate('0')).toBe('invalid')
    expect(parseRate('-1')).toBe('invalid')
    expect(parseRate('abc')).toBe('invalid')
    expect(parseRate('NaN')).toBe('invalid')
    expect(parseRate('Infinity')).toBe('invalid')
  })
})

describe('validatePricing (Settings › Pricing add/update form)', () => {
  it('requires a model name', () => {
    expect(validatePricing('', '1', '2')).toMatchObject({ ok: false, error: 'Enter a model name.' })
  })

  it('requires input and output rates', () => {
    expect(validatePricing('m', '', '2')).toMatchObject({ ok: false, error: 'Input and output rates are required.' })
    expect(validatePricing('m', '1', '')).toMatchObject({ ok: false, error: 'Input and output rates are required.' })
  })

  it('rejects non-positive rates with a rate error', () => {
    expect(validatePricing('m', '-1', '2')).toMatchObject({ ok: false, error: 'Rates must be positive numbers (USD per 1M tokens).' })
    expect(validatePricing('m', '1', '0')).toMatchObject({ ok: false, error: 'Rates must be positive numbers (USD per 1M tokens).' })
  })

  it('trims the model and returns the parsed rates on success', () => {
    const result = validatePricing('  my-model ', '3', '15')
    expect(result).toEqual({ ok: true, model: 'my-model', inputPricePerMillion: 3, outputPricePerMillion: 15 })
  })
})

describe('default-period helpers (Settings › General)', () => {
  it('exposes the canonical period values', () => {
    expect(DEFAULT_PERIOD_VALUES).toContain('today')
    expect(DEFAULT_PERIOD_VALUES).toContain('week')
    expect(DEFAULT_PERIOD_VALUES).toContain('30days')
    expect(DEFAULT_PERIOD_VALUES).toContain('all')
    expect(DEFAULT_PERIOD_VALUES).toContain('lifetime')
  })

  it('reads a stored valid period, else the fallback', () => {
    const storage = new FakeStorage()
    storage.setItem('watchtower:defaultPeriod', 'week')
    expect(readStoredDefaultPeriod(storage, 'today')).toBe('week')

    storage.setItem('watchtower:defaultPeriod', 'bogus')
    expect(readStoredDefaultPeriod(storage, 'today')).toBe('today')
    expect(readStoredDefaultPeriod(null, 'today')).toBe('today')
  })

  it('writes only valid periods', () => {
    const storage = new FakeStorage()
    writeStoredDefaultPeriod(storage, '30days')
    expect(storage.getItem('watchtower:defaultPeriod')).toBe('30days')

    writeStoredDefaultPeriod(storage, 'nope')
    expect(storage.getItem('watchtower:defaultPeriod')).toBe('30days')
  })
})
