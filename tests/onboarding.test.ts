import { describe, expect, it } from 'vitest'
import {
  isOnboarded,
  markOnboarded,
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
} from '../src/renderer/src/app/components/onboarding-steps.js'

describe('ONBOARDING_STEPS', () => {
  it('covers the welcome screen plus the 8 sections that exist in the app today', () => {
    expect(ONBOARDING_STEPS.map(step => step.id)).toEqual([
      'welcome',
      'overview',
      'sessions',
      'pullRequests',
      'spend',
      'optimize',
      'models',
      'compare',
      'settings',
    ])
  })

  it('every step has a non-empty title and body', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0)
      expect(step.body.trim().length).toBeGreaterThan(0)
    }
  })

  it('never mentions telemetry, consent, or data collection — there is no telemetry step', () => {
    const copy = ONBOARDING_STEPS.map(step => `${step.title} ${step.body}`).join(' ').toLowerCase()
    expect(copy).not.toMatch(/telemetry/)
    expect(copy).not.toMatch(/consent/)
    expect(copy).not.toMatch(/collect/i)
  })
})

describe('onboarding persistence', () => {
  function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const map = new Map<string, string>()
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
    }
  }

  it('is not onboarded before the flag is set', () => {
    expect(isOnboarded(fakeStorage())).toBe(false)
  })

  it('marks onboarded after the walkthrough is done', () => {
    const storage = fakeStorage()
    markOnboarded(storage)
    expect(isOnboarded(storage)).toBe(true)
  })

  it('persists under the stable key so it survives a relaunch', () => {
    const storage = fakeStorage()
    markOnboarded(storage)
    expect(storage.getItem(ONBOARDING_KEY)).toBe('1')
    // a fresh read against the same storage sees the completed flag
    expect(isOnboarded(storage)).toBe(true)
  })

  it('degrades to not-onboarded when storage is unavailable (never blocks)', () => {
    expect(isOnboarded(null)).toBe(false)
    expect(isOnboarded(undefined)).toBe(false)
    expect(markOnboarded(null)).toBeUndefined()
  })
})
