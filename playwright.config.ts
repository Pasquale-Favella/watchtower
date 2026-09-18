import { defineConfig } from '@playwright/test'

/**
 * Electron end-to-end (spins out of #123 W7, tracks #133).
 *
 * Playwright was picked over WebdriverIO for the scaffold: one devDependency,
 * a built-in Electron launcher (`_electron`), and no browser binaries to
 * download (`npx playwright install` is NOT needed for `e2e/` — Electron
 * tests drive the repo's own Electron binary). WebdriverIO + the Electron
 * service stays a valid later choice if multi-window or mobile-web coverage
 * ever needs it; the specs below don't depend on the runner beyond
 * `_electron.launch`.
 *
 * Unit tests stay on Vitest (`tests/`); this config only sees `e2e/`.
 * `npm run test:e2e` builds the bundles first, so the app under test is
 * always the current source (`out/`, git-ignored).
 */
export default defineConfig({
  testDir: './e2e',
  // First launch hydrates via a full scan of the host's real assistant
  // sources, so the ceiling is generous; the steady-state run is far quicker.
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  expect: {
    timeout: 30_000,
  },
})
