import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { acceleratorFor, SHORTCUTS } from '../src/shared/lib/shortcuts'
import { dismissOnboarding, withApp } from './app'

/**
 * Background shell: closing the main window keeps the app alive in the tray
 * and floats the orb — a fixed 64px window — with its spend panel in a
 * window of its own beside it. Host-independent: it asserts the controls and
 * the wiring, never data values.
 */

type Surface = 'main' | 'orb' | 'panel'
const PAGE: Record<Surface, string> = { main: 'index.html', orb: 'orb.html', panel: 'orb-panel.html' }

test('closing the window backgrounds the app into the orb, which reopens it', async () => {
  await withApp(async ({ app, window }) => {
    await dismissOnboarding(window)
    // Leave the app on Settings, so the panel's "See overview" has to navigate.
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(window.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()

    // Window-level state: a hidden window's DOM still reads as CSS-visible.
    const surface = (which: Surface) =>
      app.evaluate(({ BrowserWindow }, page) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith(page))
        return win ? { visible: win.isVisible(), bounds: win.getBounds(), opacity: win.getOpacity() } : null
      }, PAGE[which])
    const visible = async (which: Surface): Promise<boolean> => (await surface(which))?.visible ?? false
    const opened = (which: Surface): Promise<Page> =>
      app.waitForEvent('window', { predicate: page => page.url().endsWith(PAGE[which]) })

    const orbOpened = opened('orb')
    const panelOpened = opened('panel')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    const [orb, panel] = await Promise.all([orbOpened, panelOpened])
    const surfaceErrors: Error[] = []
    for (const page of [orb, panel]) page.on('pageerror', error => surfaceErrors.push(error))

    // Closed means hidden, not destroyed: the ledger keeps running.
    await expect.poll(() => visible('main')).toBe(false)
    const orbButton = orb.getByRole('button', { name: /Watchtower panel/ })
    await expect(orbButton).toBeVisible()

    // The first close peeks the panel (once its data is in) with a note, and
    // the peek folds itself away.
    await expect.poll(() => visible('panel'), { timeout: 60_000 }).toBe(true)
    await expect(panel.getByText(/^Still watching in the background/)).toBeVisible()
    await expect.poll(() => visible('panel'), { timeout: 15_000 }).toBe(false)

    // A click opens the panel beside the orb — and the orb does not move: its
    // window never resizes (a moving resize repaints at the old origin).
    const before = (await surface('orb'))?.bounds
    await orbButton.click()
    await expect.poll(() => visible('panel')).toBe(true)
    await expect(panel.getByText('Spend over time', { exact: true })).toBeVisible()
    expect((await surface('orb'))?.bounds).toEqual(before)
    // It is shown transparent and revealed once its page painted a fresh
    // frame (no stale-frame flicker) — and always ends up fully opaque.
    await expect.poll(async () => (await surface('panel'))?.opacity).toBe(1)

    // Escape folds the panel (the open root holds DOM focus).
    await panel.keyboard.press('Escape')
    await expect.poll(() => visible('panel')).toBe(false)

    // A click is the orb's only gesture: neither a quick open-then-fold nor a
    // drag followed by a click — both double-clicks to the OS (clickCount 2)
    // — may reopen the full app.
    const box = await orbButton.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await orb.mouse.click(cx, cy)
      await expect.poll(() => visible('panel')).toBe(true)
      await orb.mouse.down({ clickCount: 2 })
      await orb.mouse.up({ clickCount: 2 })
      await expect.poll(() => visible('panel')).toBe(false)

      await orb.mouse.move(cx, cy)
      await orb.mouse.down()
      await orb.mouse.move(cx + 12, cy, { steps: 3 })
      await orb.mouse.move(cx, cy, { steps: 3 })
      await orb.mouse.up()
      await orb.mouse.down({ clickCount: 2 })
      await orb.mouse.up({ clickCount: 2 })
      await orb.waitForTimeout(800)
      expect(await visible('main')).toBe(false)
    }
    if (!(await visible('panel'))) await orbButton.click()
    await expect.poll(() => visible('panel')).toBe(true)

    // One scan, every window: a scan started from the panel streams its
    // progress to the (hidden) main window too, not only to the requester.
    await window.evaluate(() => {
      const probe = globalThis as unknown as {
        api: { onProgress: (cb: () => void) => () => void }
        __orbScanProgress?: number
      }
      probe.__orbScanProgress = 0
      probe.api.onProgress(() => {
        probe.__orbScanProgress = (probe.__orbScanProgress ?? 0) + 1
      })
    })
    await panel.getByRole('button', { name: 'Scan now' }).click()
    await expect
      .poll(() => window.evaluate(() => (globalThis as { __orbScanProgress?: number }).__orbScanProgress ?? 0), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)

    // Every page shares one origin even in a build (file://): a theme the
    // main window persists reaches both orb windows live.
    await window.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('watchtower:settings') ?? '{"state":{},"version":0}')
      raw.state.theme = 'dark'
      localStorage.setItem('watchtower:settings', JSON.stringify(raw))
    })
    for (const page of [orb, panel]) await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)

    await panel.getByRole('button', { name: /^See overview/ }).click()
    await expect.poll(() => visible('main')).toBe(true)
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()
    await expect.poll(() => visible('orb')).toBe(false)

    // The peek explains the orb once per session: a second close floats the
    // orb with its panel folded, and no note.
    await app.evaluate(({ BrowserWindow }, page) => {
      BrowserWindow.getAllWindows()
        .find(w => w.webContents.getURL().endsWith(page))
        ?.close()
    }, PAGE.main)
    await expect.poll(() => visible('orb')).toBe(true)
    await orb.waitForTimeout(2_000)
    expect(await visible('panel')).toBe(false)

    // The registry's global summon shortcut: registered for as long as the
    // app runs — or, when another process holds the combination, refused
    // with a logged warning and never fatal. Either honours the contract.
    const summon = SHORTCUTS.find(def => def.action === 'summonOrb' && def.scope === 'global')
    expect(summon).toBeDefined()
    if (summon) {
      const accelerator = acceleratorFor(summon.hotkey)
      const registered = await app.evaluate(
        ({ globalShortcut }, combo) => globalShortcut.isRegistered(combo),
        accelerator,
      )
      if (!registered) {
        const logDir = join(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')), 'logs')
        const refusals = readdirSync(logDir)
          .filter(file => file.startsWith('operational'))
          .flatMap(file => readFileSync(join(logDir, file), 'utf8').split('\n'))
          .filter(line => line.includes('shell.shortcut-unavailable'))
        expect(refusals.length, 'an unregistered summon shortcut must log its refusal').toBeGreaterThan(0)
      }
    }
    expect(surfaceErrors).toEqual([])
  })
})
