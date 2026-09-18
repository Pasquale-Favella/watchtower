import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'

/**
 * Smoke (spins out of #123 W7, tracks #133): the built app boots in a real
 * Electron window against an isolated profile, the first-run onboarding
 * dismisses, and section navigation works without renderer crashes.
 *
 * Isolation: every run gets a fresh `--user-data-dir` under the OS temp root
 * (ledger, cache, and settings all live under `userData`), so the suite never
 * touches the developer's real Watchtower data and always exercises the
 * first-launch path. The profile is removed in `finally`.
 *
 * Precondition: `npm run build` (wired into `npm run test:e2e`) — `electron
 * .` boots `package.json`'s `main` (`out/main/index.js`), which the build
 * emits alongside the preload and renderer bundles.
 */
test('app boots, onboarding dismisses, sections navigate', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'watchtower-e2e-'))
  const args = ['.']
  // Root-owned Linux CI (and Docker) needs the Chromium sandbox off; Windows
  // and macOS run with the default sandbox.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  args.push(`--user-data-dir=${userDataDir}`)

  const app = await electron.launch({ args, timeout: 60_000 })
  try {
    const window = await app.firstWindow({ timeout: 60_000 })
    const pageErrors: Error[] = []
    window.on('pageerror', error => {
      pageErrors.push(error)
    })

    await expect(window).toHaveTitle(/Watchtower/)

    // First launch shows the Splash (Splash.tsx) until the scan store
    // hydrates — and hydration needs a full scan of the host's real
    // assistant sources (read-only; the ledger lands in the isolated
    // profile), so this wait dominates the suite's runtime. The shell and
    // the first-run onboarding dialog (Onboarding.tsx) mount together
    // post-hydration, and the open modal inerts the background
    // (`aria-hidden`), so wait for the dialog's own "Skip" as the POSITIVE
    // ready signal — sidebar roles don't exist in the tree until the dialog
    // closes. Fail fast with the scan error instead of timing out.
    const scanRetry = window.getByRole('button', { name: 'Retry' })
    const skip = window.getByRole('button', { name: 'Skip' })
    await expect.poll(async () => {
      if (await skip.isVisible().catch(() => false)) return 'onboard'
      if (await scanRetry.isVisible().catch(() => false)) return 'scan-error'
      return 'waiting'
    }, { timeout: 240_000 }).toBe('onboard')

    // "Skip" dismisses the tour for good via the settings store; the sidebar
    // joins the accessibility tree once the modal closes.
    await skip.click()
    await expect(skip).toBeHidden()

    // Sessions shows host-dependent content (the suite scans the machine's
    // real sources read-only): real rows with a search box, or the empty
    // note on a sourceless host. Either proves the view switch (the router
    // is memory-history, so there is no URL to assert).
    // Sidebar labels come from the shortcuts registry (ADR 0001).
    const searchSessions = window.getByRole('textbox', { name: 'Search sessions' })
    const sessionsEmpty = window.getByText('No sessions in this range yet.')
    await window.getByRole('button', { name: 'Sessions', exact: true }).click()
    await expect.poll(async () => {
      if (await searchSessions.isVisible().catch(() => false)) return 'populated'
      if (await sessionsEmpty.isVisible().catch(() => false)) return 'empty'
      return 'waiting'
    }, { timeout: 30_000 }).not.toBe('waiting')

    // Back to Overview: the Sessions content unmounts and the KPI strip shows
    // ("Total spend" renders uppercase via CSS; getByText sees DOM text).
    await window.getByRole('button', { name: 'Overview', exact: true }).click()
    await expect(searchSessions.or(sessionsEmpty)).toBeHidden()
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()
    expect(app.windows().length).toBe(1)

    expect(pageErrors).toEqual([])
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
