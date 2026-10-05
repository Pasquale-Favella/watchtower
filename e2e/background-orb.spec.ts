import { expect, test } from '@playwright/test'

import { acceleratorFor, SHORTCUTS } from '../src/shared/lib/shortcuts'
import { dismissOnboarding, withApp } from './app'

/**
 * Background shell: closing the main window keeps the app alive in the tray
 * and floats the orb; the orb unfolds its spend panel and reopens the app on
 * a section. Host-independent — it asserts the controls, never data values.
 */
test('closing the window backgrounds the app into the orb, which reopens it', async () => {
  await withApp(async ({ app, window }) => {
    await dismissOnboarding(window)
    // Leave the app on Settings, so the orb's "See overview" has to navigate.
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(window.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()

    const orbOpened = app.waitForEvent('window', { predicate: page => page.url().includes('orb.html') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    const orb = await orbOpened
    const orbErrors: Error[] = []
    orb.on('pageerror', error => orbErrors.push(error))

    // Closed means hidden, not destroyed: the ledger keeps running.
    const mainVisible = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(win => !win.webContents.getURL().includes('orb.html') && win.isVisible()),
      )
    await expect.poll(mainVisible).toBe(false)

    const orbButton = orb.getByRole('button', { name: /Watchtower panel/ })
    await expect(orbButton).toBeVisible()

    // The first close peeks the panel with a "still watching" note, which
    // folds itself away; then a click on the orb unfolds the spend panel,
    // whose "See overview" brings the full app back on the Overview section.
    const seeOverview = orb.getByRole('button', { name: /^See overview/ })
    await expect(orb.getByText(/^Still watching in the background/)).toBeVisible()
    await expect(seeOverview).toBeHidden({ timeout: 15_000 })
    await orbButton.click()
    await expect(orb.getByText('Spend over time', { exact: true })).toBeVisible()

    // Escape folds the panel (the unfolded root holds DOM focus).
    await orb.keyboard.press('Escape')
    await expect(seeOverview).toBeHidden()
    await orbButton.click()
    await expect(seeOverview).toBeVisible()

    // Both pages share one origin even in a build (file://): a theme the
    // main window persists reaches the orb live through the `storage` event.
    await window.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('watchtower:settings') ?? '{"state":{},"version":0}')
      raw.state.theme = 'dark'
      localStorage.setItem('watchtower:settings', JSON.stringify(raw))
    })
    await expect(orb.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)

    await seeOverview.click()
    await expect.poll(mainVisible).toBe(true)
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()

    // The peek explains the orb once per session: a second close floats the
    // orb folded, without the note.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find(win => !win.webContents.getURL().includes('orb.html'))
        ?.close(),
    )
    await expect.poll(mainVisible).toBe(false)
    await expect(orbButton).toBeVisible()
    await orb.waitForTimeout(2_000)
    await expect(orb.getByText(/^Still watching in the background/)).toHaveCount(0)
    await expect(seeOverview).toBeHidden()

    // The registry's global summon shortcut is live for as long as the app
    // runs, so the orb can come back even after it was hidden from its panel.
    const summon = SHORTCUTS.find(def => def.action === 'summonOrb' && def.scope === 'global')
    expect(summon).toBeDefined()
    if (summon) {
      const registered = await app.evaluate(
        ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
        acceleratorFor(summon.hotkey),
      )
      expect(registered).toBe(true)
    }
    expect(orbErrors).toEqual([])
  })
})
