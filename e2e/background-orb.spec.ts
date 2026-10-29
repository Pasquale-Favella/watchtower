import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import type { Api } from '../src/platform/electron/preload/index.js'
import { acceleratorFor, SHORTCUTS } from '../src/shared/lib/shortcuts'
import { dismissOnboarding, withApp } from './app'
import { invokeRpc } from './rpc-probe'

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
    const opened = async (which: Surface): Promise<Page> => {
      // Electron may emit `window` before its Page has navigated. Discover
      // the loaded surface instead of rejecting that one-shot event forever.
      await expect.poll(() => app.windows().some(page => page.url().endsWith(PAGE[which]))).toBe(true)
      const page = app.windows().find(candidate => candidate.url().endsWith(PAGE[which]))
      if (!page) throw new Error(`${which} window disappeared after navigation`)
      return page
    }

    const orbOpened = opened('orb')
    const panelOpened = opened('panel')
    // Playwright's synthetic pointer does not move the host's native cursor.
    // Keep this auto-fold assertion independent of someone using the computer.
    const cursorReader = await app.evaluateHandle(({ screen }) => screen.getCursorScreenPoint)
    await app.evaluate(({ screen }) => {
      screen.getCursorScreenPoint = () => ({ x: -100_000, y: -100_000 })
    })
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
    // Orb presses must also report an Orb-native cursor position. Otherwise
    // the panel's blur handler treats a synthetic press as an outside click
    // and races the renderer's own toggle.
    await app.evaluate(({ BrowserWindow, screen }, page) => {
      screen.getCursorScreenPoint = () => {
        const bounds = BrowserWindow.getAllWindows()
          .find(win => win.webContents.getURL().endsWith(page))
          ?.getBounds()
        if (!bounds) throw new Error('Orb window unavailable')
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      }
    }, PAGE.orb)

    // A click opens the panel beside the orb — and the orb does not move: its
    // window never resizes (a moving resize repaints at the old origin).
    const before = (await surface('orb'))?.bounds
    await orbButton.click()
    await expect.poll(() => visible('panel')).toBe(true)
    await expect(panel.getByText('Spend over time', { exact: true })).toBeVisible()
    expect((await surface('orb'))?.bounds).toEqual(before)

    // Main admits drag commands only from the beacon and panel paint
    // acknowledgements only from the panel. An admitted drag updates native
    // window bounds through the RPC owner.
    expect((await invokeRpc(panel, 'orb:command', { _tag: 'DragStart' })).ok).toBe(false)
    expect((await invokeRpc(orb, 'orb:command', { _tag: 'PanelPainted' })).ok).toBe(false)
    const drag = await app.evaluate(({ BrowserWindow, screen }, page) => {
      const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith(page))
      if (!win) return null
      const bounds = win.getBounds()
      const area = screen.getDisplayMatching(bounds).workArea
      return {
        bounds,
        dx: bounds.x + bounds.width / 2 < area.x + area.width / 2 ? 16 : -16,
        dy: bounds.y + bounds.height / 2 < area.y + area.height / 2 ? 16 : -16,
      }
    }, PAGE.orb)
    expect(drag).not.toBeNull()
    if (drag) {
      expect((await invokeRpc(panel, 'orb:command', { _tag: 'PanelPainted' })).ok).toBe(true)
      expect((await invokeRpc(orb, 'orb:command', { _tag: 'DragStart' })).ok).toBe(true)
      expect((await invokeRpc(orb, 'orb:command', { _tag: 'DragMove', dx: drag.dx, dy: drag.dy })).ok).toBe(true)
      expect((await invokeRpc(orb, 'orb:command', { _tag: 'DragEnd' })).ok).toBe(true)
      expect((await surface('orb'))?.bounds).not.toEqual(drag.bounds)
    }
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
      await expect(orbButton).toHaveAccessibleName('Fold Watchtower panel')
      await orb.mouse.down({ clickCount: 2 })
      await orb.mouse.up({ clickCount: 2 })
      await expect.poll(() => visible('panel')).toBe(false)
      await expect(orbButton).toHaveAccessibleName('Show Watchtower panel')

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
    await app.evaluate(({ screen }, reader) => {
      screen.getCursorScreenPoint = reader
    }, cursorReader)
    await cursorReader.dispose()

    // One scan, every window: a scan started from the panel streams its
    // progress to the (hidden) main window too, not only to the requester.
    await window.evaluate(async () => {
      const probe = globalThis as unknown as {
        api: Api
        __orbScanProgress?: number
        __orbStopScanProbe?: () => void
      }
      const bridge = probe.api.rpcV1
      const connection = await bridge.connect()
      if (connection._tag !== 'Connected') throw new Error('Main RPC connection unavailable')
      const requestId = `orb-progress-${crypto.randomUUID()}`
      probe.__orbScanProgress = 0
      const unsubscribe = bridge.onMessage(raw => {
        if (typeof raw !== 'string') return
        const frame = JSON.parse(raw)
        if (frame._tag !== 'Chunk' || frame.requestId !== requestId) return
        for (const value of frame.values)
          if (value._tag === 'Event' && value.envelope.event._tag === 'ScanProgress')
            probe.__orbScanProgress = (probe.__orbScanProgress ?? 0) + 1
        void bridge.send(JSON.stringify({ _tag: 'Ack', requestId }), connection.generation).catch(() => {})
      }, connection.generation)
      probe.__orbStopScanProbe = () => {
        unsubscribe()
        void bridge.send(JSON.stringify({ _tag: 'Interrupt', requestId }), connection.generation).catch(() => {})
        delete probe.__orbStopScanProbe
      }
      await bridge.send(
        JSON.stringify({
          _tag: 'Request',
          id: requestId,
          tag: 'app:events',
          headers: [],
          payload: { categories: ['scan'], snapshot: 'versions' },
        }),
        connection.generation,
      )
    })
    try {
      await panel.getByRole('button', { name: 'Scan now' }).click()
      await expect
        .poll(() => window.evaluate(() => (globalThis as { __orbScanProgress?: number }).__orbScanProgress ?? 0), {
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
    } finally {
      await window.evaluate(() => (globalThis as { __orbStopScanProbe?: () => void }).__orbStopScanProbe?.())
    }

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
