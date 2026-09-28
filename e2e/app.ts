import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'

/**
 * Shared Electron launch + first-run helpers for `e2e/*.spec.ts` (tracks
 * #133). Every spec boots the BUILT app (`npm run build` first — wired into
 * `npm run test:e2e`) against a fresh `--user-data-dir` under the OS temp
 * root, so the suite never touches the developer's real Watchtower data and
 * always exercises the first-launch path (Splash → onboarding).
 *
 * Rules for new specs (keeps the suite host-independent — the boot scan reads
 * the machine's real sources READ-ONLY into the isolated ledger, so content
 * varies):
 * - never assert on data values, row counts, or URLs (memory-history router);
 * - key readiness off `dismissOnboarding`, not the splash (pre-mount DOM also
 *   matches "hidden" checks);
 * - assert each view via `waitForAnyVisible` with content-OR-empty markers;
 * - wrap every spec in `withApp` — it asserts zero renderer `pageerror`s.
 */
export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  pageErrors: Error[]
  close: () => Promise<void>
}

export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'watchtower-e2e-'))
  const args = [
    // Root-owned Linux CI (and Docker) needs the Chromium sandbox off;
    // Windows and macOS run with the default sandbox.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    '.',
    `--user-data-dir=${userDataDir}`,
  ]

  const app = await electron.launch({ args, timeout: 60_000 })
  const window = await app.firstWindow({ timeout: 60_000 })
  const pageErrors: Error[] = []
  window.on('pageerror', error => {
    pageErrors.push(error)
  })
  return {
    app,
    window,
    pageErrors,
    close: async () => {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
    },
  }
}

/**
 * First launch hydrates through a full scan, then mounts the shell and the
 * onboarding dialog together — and the open modal inerts the background
 * (`aria-hidden`), so sidebar roles don't exist in the tree until the dialog
 * closes. Wait for the dialog's own "Skip" as the POSITIVE ready signal and
 * dismiss it. Fails fast when the boot scan errors (splash "Retry").
 */
export async function dismissOnboarding(window: Page): Promise<void> {
  const scanRetry = window.getByRole('button', { name: 'Retry' })
  const skip = window.getByRole('button', { name: 'Skip' })
  // Settle on either terminal boot state, then distinguish: a bare
  // `.toBe('onboard')` would report a broken scan as a timeout, hiding the
  // signal the splash already shows.
  await expect
    .poll(
      async () => {
        if (await scanRetry.isVisible().catch(() => false)) return 'scan-error'
        if (await skip.isVisible().catch(() => false)) return 'onboard'
        return 'waiting'
      },
      { timeout: 240_000 },
    )
    .not.toBe('waiting')
  expect(await scanRetry.isVisible(), 'boot scan failed (splash shows Retry)').toBe(false)

  await skip.click()
  await expect(skip).toBeHidden()
}

/**
 * Resolve when ANY of the locators is visible — pass one locator per
 * possible view state (content / empty / degraded) so specs stay green on
 * hosts with and without data.
 */
export async function waitForAnyVisible(locators: Locator[], timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const locator of locators) {
          if (await locator.isVisible().catch(() => false)) return 'visible'
        }
        return 'waiting'
      },
      { timeout },
    )
    .not.toBe('waiting')
}

/**
 * One launch per spec: boots the app, runs the body, asserts zero renderer
 * `pageerror`s, then always closes the app and removes the temp profile —
 * specs stay focused on behavior instead of repeating the lifecycle triple.
 */
export async function withApp(body: (ctx: { app: ElectronApplication; window: Page }) => Promise<void>): Promise<void> {
  const { app, window, pageErrors, close } = await launchApp()
  try {
    await body({ app, window })
    expect(pageErrors).toEqual([])
  } finally {
    await close()
  }
}
