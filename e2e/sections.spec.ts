import { test, expect, type Locator, type Page } from '@playwright/test'
import { dismissOnboarding, waitForAnyVisible, withApp } from './app'

/**
 * Section walk (tracks #133): every sidebar destination renders its view
 * without renderer errors, on whatever host data the read-only boot scan
 * finds. Markers are data-independent — one locator per possible view state
 * (content OR empty), never values, counts, or URLs (memory-history router).
 *
 * The list mirrors the app's section order (NAV_SECTIONS in
 * src/renderer/src/app/shortcuts.ts) by label on purpose: e2e stays out of
 * the renderer module graph (node context, no `@` alias), so a new Section
 * updates this map plus the registry — the Record type keeps the map
 * exhaustive.
 */
const SECTIONS = [
  'Overview',
  'Sessions',
  'Pull requests',
  'Spend',
  'Optimize',
  'Models',
  'Compare',
  'Coach & Skills',
  'Settings',
] as const

type SectionName = (typeof SECTIONS)[number]

const MARKERS: Record<SectionName, (window: Page) => Locator[]> = {
  Overview: window => [window.getByText('Total spend', { exact: true })],
  Sessions: window => [
    window.getByRole('textbox', { name: 'Search sessions' }),
    window.getByText('No sessions in this range yet.'),
  ],
  'Pull requests': window => [window.getByText('Attributed pull requests'), window.getByText(/PR links are captured/)],
  Spend: window => [window.getByText('Daily spend by model'), window.getByText('No model spend in this range yet.')],
  // Tab labels carry live values (`Waste $1.23`), so match the prefix.
  Optimize: window => [window.getByRole('tab', { name: /^Waste/ })],
  Models: window => [window.getByRole('tab', { name: 'By model' })],
  Compare: window => [
    window.getByRole('combobox', { name: 'First model' }),
    window.getByText('Need at least two models with usage in this range to compare.'),
  ],
  'Coach & Skills': window => [window.getByRole('button', { name: 'Send message' })],
  Settings: window => [window.getByRole('navigation', { name: 'Settings sections' })],
}

test('every section renders without errors', async () => {
  await withApp(async ({ app, window }) => {
    await expect(window).toHaveTitle(/Watchtower/)
    await dismissOnboarding(window)

    for (const nav of SECTIONS) {
      await window.getByRole('button', { name: nav, exact: true }).click()
      await waitForAnyVisible(MARKERS[nav](window))
    }

    expect(app.windows().length).toBe(1)
  })
})
