import type { ProviderOption, Theme } from '../../../../shared/schemas/renderer.js'
export type { ProviderOption, Theme }

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Builds the provider filter's options list from the providers actually
 * detected on the machine (per-section data, e.g. the analytics view's
 * `providers` list) — "detected-only" rendering, so the picker never offers a
 * provider that isn't present. "All providers" is always first.
 */
export function providerOptionsFromDetected(detectedNames: string[]): ProviderOption[] {
  const unique = Array.from(new Set(detectedNames)).sort((a, b) => a.localeCompare(b))
  return [{ value: 'all', label: 'All providers' }, ...unique.map(name => ({ value: name, label: titleCase(name) }))]
}

/** The top bar's scope caption: "period · provider[ · config]". */
export function buildScopeCaption(periodLabel: string, providerLabel: string, configLabel?: string): string {
  const parts = [periodLabel, providerLabel]
  if (configLabel) parts.push(configLabel)
  return parts.join(' · ')
}

/** Cadence dropdown options for the Settings > General cadence control
 * (ADR 0004). Mirrors src/main/cadence.ts's CADENCE_OPTIONS values
 * exactly — renderer code can't import main-process modules directly, so
 * this list is kept in sync by hand; the ipc cadence:get/cadence:set calls
 * are the source of truth for the persisted value itself. */
export const CADENCE_UI_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: '30s', label: '30 seconds' },
  { value: '1m', label: '1 minute' },
  { value: '3m', label: '3 minutes' },
  { value: '5m', label: '5 minutes' },
  { value: '10m', label: '10 minutes' },
]

/**
 * Resolves the app's initial theme MODE (Settings › General offers
 * system/light/dark): an explicit saved preference always wins; otherwise the
 * app follows the OS (via `themeIsDark`, which maps `'system'` onto
 * `prefers-color-scheme` at render time). Pure/injectable (no direct
 * localStorage/matchMedia reads) so it's testable without jsdom — AppRoot
 * supplies the real `savedTheme` from the browser APIs.
 */
export function resolveThemeMode(savedTheme: string | null): Theme {
  if (savedTheme === 'dark' || savedTheme === 'light' || savedTheme === 'system') return savedTheme
  return 'system'
}

/** Whether the current theme mode resolves to dark, given the OS's
 * `prefers-color-scheme`. 'light'/'dark' force the answer; 'system' defers. */
export function themeIsDark(mode: Theme, prefersDark: boolean): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return prefersDark
}
