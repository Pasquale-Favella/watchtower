import { test, expect, type Locator, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp, waitForAnyVisible } from './app'

/**
 * Section walk (tracks #133): every sidebar destination renders its view
 * without renderer errors, on whatever host data the read-only boot scan
 * finds. Markers are data-independent — one locator per possible view state
 * (content OR empty), never values, counts, or URLs (memory-history router).
 * Sidebar labels come from the shortcuts registry (ADR 0001).
 */
function markersFor(window: Page, nav: string): Locator[] {
  switch (nav) {
    case 'Overview':
      return [window.getByText('Total spend', { exact: true })]
    case 'Sessions':
      return [
        window.getByRole('textbox', { name: 'Search sessions' }),
        window.getByText('No sessions in this range yet.'),
      ]
    case 'Pull requests':
      return [
        window.getByText('Attributed pull requests'),
        window.getByText(/PR links are captured/),
      ]
    case 'Spend':
      return [
        window.getByText('Daily spend by model'),
        window.getByText('No model spend in this range yet.'),
      ]
    case 'Optimize':
      // Tab labels carry live values (`Waste $1.23`), so match the prefix.
      return [window.getByRole('tab', { name: /^Waste/ })]
    case 'Models':
      return [window.getByRole('tab', { name: 'By model' })]
    case 'Compare':
      return [
        window.getByRole('combobox', { name: 'First model' }),
        window.getByText('Need at least two models with usage in this range to compare.'),
      ]
    case 'Coach & Skills':
      return [window.getByRole('button', { name: 'Send message' })]
    case 'Settings':
      return [window.getByRole('navigation', { name: 'Settings sections' })]
    default:
      throw new Error(`no e2e markers for section ${JSON.stringify(nav)}`)
  }
}

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
]

test('every section renders without errors', async () => {
  const { app, window, pageErrors, close } = await launchApp()
  try {
    await expect(window).toHaveTitle(/Watchtower/)
    await dismissOnboarding(window)

    for (const nav of SECTIONS) {
      await window.getByRole('button', { name: nav, exact: true }).click()
      await waitForAnyVisible(markersFor(window, nav))
    }

    expect(app.windows().length).toBe(1)
    expect(pageErrors).toEqual([])
  } finally {
    await close()
  }
})
