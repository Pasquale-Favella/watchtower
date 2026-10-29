/**
 * Pure helpers for the Settings section — formatting, pricing-form
 * validation, and the persisted default-period read/write. Kept free of any
 * DOM/base-ui imports so they're unit-testable in plain node (the desktop
 * suite runs without jsdom).
 */

import { DEFAULT_PERIOD_VALUES } from '@/shared/lib/settings-constants'

const DEFAULT_PERIOD_KEY = 'watchtower:defaultPeriod'

/** Reads the persisted default period, validating it against the canonical
 * set so a stale/corrupt value falls back instead of breaking the period
 * switcher. `null` storage (hardened contexts) also falls back. */
export function readStoredDefaultPeriod(storage: Pick<Storage, 'getItem'> | null, fallback: string): string {
  try {
    const saved = storage?.getItem(DEFAULT_PERIOD_KEY)
    if (saved && DEFAULT_PERIOD_VALUES.includes(saved)) return saved
  } catch {
    /* storage can be unavailable — fall through to the fallback */
  }
  return fallback
}

/** Persists a default period, ignoring values outside the canonical set. */
export function writeStoredDefaultPeriod(storage: Pick<Storage, 'setItem'> | null, value: string): void {
  if (!DEFAULT_PERIOD_VALUES.includes(value)) return
  try {
    storage?.setItem(DEFAULT_PERIOD_KEY, value)
  } catch {
    /* storage can be unavailable in hardened contexts; setting is best-effort */
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** '' -> not provided; a positive finite number -> a rate; 'invalid' otherwise.
 * Mirrors the Settings › Pricing `parseRate` semantics. */
export function parseRate(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return 'invalid'
  return value
}

export type PricingValidation =
  | { ok: true; model: string; inputPricePerMillion: number; outputPricePerMillion: number }
  | { ok: false; error: string }

/** Validates the Settings › Pricing add form. Input/output are required and
 * must parse to positive numbers; the model must be non-empty. */
export function validatePricing(modelRaw: string, inputRaw: string, outputRaw: string): PricingValidation {
  if (!modelRaw.trim()) return { ok: false, error: 'Enter a model name.' }
  const input = parseRate(inputRaw)
  const output = parseRate(outputRaw)
  if (input === 'invalid' || output === 'invalid') {
    return { ok: false, error: 'Rates must be positive numbers (USD per 1M tokens).' }
  }
  if (input === undefined || output === undefined) {
    return { ok: false, error: 'Input and output rates are required.' }
  }
  return { ok: true, model: modelRaw.trim(), inputPricePerMillion: input, outputPricePerMillion: output }
}
