import { test, expect } from '@playwright/test'
import { dismissOnboarding, launchApp, waitForAnyVisible } from './app'

/**
 * Smoke (spins out of #123 W7, tracks #133): the built app boots in a real
 * Electron window against an isolated profile, the first-run onboarding
 * dismisses, and section navigation works without renderer crashes.
 */
test('app boots, onboarding dismisses, sections navigate', async () => {
  const { app, window, pageErrors, close } = await launchApp()
  try {
    await expect(window).toHaveTitle(/Watchtower/)
    await dismissOnboarding(window)

    // Sessions shows host-dependent content (the suite scans the machine's
    // real sources read-only): real rows with a search box, or the empty
    // note on a sourceless host. Either proves the view switch (the router
    // is memory-history, so there is no URL to assert).
    // Sidebar labels come from the shortcuts registry (ADR 0001).
    const searchSessions = window.getByRole('textbox', { name: 'Search sessions' })
    const sessionsEmpty = window.getByText('No sessions in this range yet.')
    await window.getByRole('button', { name: 'Sessions', exact: true }).click()
    await waitForAnyVisible([searchSessions, sessionsEmpty])

    // Back to Overview: the Sessions content unmounts and the KPI strip shows
    // ("Total spend" renders uppercase via CSS; getByText sees DOM text).
    await window.getByRole('button', { name: 'Overview', exact: true }).click()
    await expect(searchSessions.or(sessionsEmpty)).toBeHidden()
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()
    expect(app.windows().length).toBe(1)

    expect(pageErrors).toEqual([])
  } finally {
    await close()
  }
})
