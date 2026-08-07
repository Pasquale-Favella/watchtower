import { describe, expect, it } from 'vitest'
import { CADENCE_OPTIONS, DEFAULT_CADENCE, resolveCadenceMs, isValidCadence } from '../src/main/cadence.js'

describe('CADENCE_OPTIONS', () => {
  it('offers manual plus the fixed intervals (30s/1m/3m/5m/10m)', () => {
    expect(CADENCE_OPTIONS.map(o => o.value)).toEqual(['manual', '30s', '1m', '3m', '5m', '10m'])
  })

  it('manual resolves to a null interval (no background scan timer)', () => {
    expect(CADENCE_OPTIONS.find(o => o.value === 'manual')?.ms).toBeNull()
  })
})

describe('resolveCadenceMs', () => {
  it('resolves each fixed-interval value to its millisecond duration', () => {
    expect(resolveCadenceMs('30s')).toBe(30_000)
    expect(resolveCadenceMs('1m')).toBe(60_000)
    expect(resolveCadenceMs('3m')).toBe(180_000)
    expect(resolveCadenceMs('5m')).toBe(300_000)
    expect(resolveCadenceMs('10m')).toBe(600_000)
  })

  it('resolves "manual" to null — no timer should be scheduled', () => {
    expect(resolveCadenceMs('manual')).toBeNull()
  })

  it('falls back to the default cadence for an unrecognized value', () => {
    expect(resolveCadenceMs('bogus')).toBe(resolveCadenceMs(DEFAULT_CADENCE))
  })
})

describe('isValidCadence', () => {
  it('accepts only the known cadence values', () => {
    expect(isValidCadence('manual')).toBe(true)
    expect(isValidCadence('1m')).toBe(true)
    expect(isValidCadence('bogus')).toBe(false)
    expect(isValidCadence('')).toBe(false)
  })
})
