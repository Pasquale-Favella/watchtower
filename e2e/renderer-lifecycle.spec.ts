import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { build } from 'vite'

import type { UpdateStatus } from '../src/shared/schemas/updates'

test('development StrictMode shares bootstrap ownership and disposes the window registry', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-lifecycle-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let page: Page | undefined
  const mainOutput: string[] = []
  const rendererOutput: string[] = []
  let readFixtureDiagnostics: () => Promise<string> = async () => '(fixture unavailable)'
  const observedPages = new WeakSet<object>()
  const observePage = (page: Page) => {
    if (observedPages.has(page)) return
    observedPages.add(page)
    page.on('pageerror', error => rendererOutput.push(`pageerror: ${error.stack ?? error.message}`))
    page.on('console', message => {
      if (message.type() === 'error') rendererOutput.push(`console error: ${message.text()}`)
    })
    page.on('crash', () => rendererOutput.push('renderer process crashed'))
  }
  const diagnosticDetails = () =>
    `\nElectron stdout/stderr:\n${mainOutput.join('') || '(empty)'}\nRenderer diagnostics:\n${rendererOutput.join('\n') || '(empty)'}`
  try {
    await build({
      configFile: false,
      root: resolve('e2e/fixtures'),
      base: './',
      esbuild: { jsx: 'automatic' },
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      resolve: { alias: { '@': resolve('src/renderer/src') } },
      logLevel: 'error',
      build: {
        outDir: join(directory, 'renderer'),
        minify: false,
        rollupOptions: { input: resolve('e2e/fixtures/renderer-lifecycle.html') },
      },
    })
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('e2e/fixtures/renderer-lifecycle-main.mjs'),
        join(directory, 'renderer/renderer-lifecycle.html'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    const child = app.process()
    child.stdout?.on('data', chunk => mainOutput.push(String(chunk)))
    child.stderr?.on('data', chunk => mainOutput.push(String(chunk)))
    child.on('exit', (code, signal) => mainOutput.push(`Electron process exited: code=${code}, signal=${signal}\n`))
    app.on('window', observePage)
    const activePage = await app.firstWindow()
    page = activePage
    observePage(activePage)
    const errors: string[] = []
    activePage.on('pageerror', error => errors.push(error.message))
    const state = () =>
      activePage.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & {
            lifecycleProbe: {
              counts: {
                effectSetups: number
                effectCleanups: number
                scanCalls: number
                nativeReads: Record<string, number>
                unexpectedRequests: string[]
                attaches: number
                detaches: number
                rpcConnects: number
                lifecycleSubscriptions: number
                activeLifecycleSubscriptions: number
              }
              listeners(): number
              nodes(): number
            }
          }
        ).lifecycleProbe
        return { ...probe.counts, listeners: probe.listeners(), nodes: probe.nodes() }
      })
    readFixtureDiagnostics = async () => {
      if (!page) return '(page unavailable)'
      try {
        return JSON.stringify(
          await page.evaluate(() =>
            (
              globalThis as typeof globalThis & {
                lifecycleProbe: { diagnostics(): unknown }
              }
            ).lifecycleProbe.diagnostics(),
          ),
          null,
          2,
        )
      } catch (error) {
        return `diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    await expect(activePage.locator('[data-ready="true"]')).toHaveText('$10.00', { timeout: 10_000 })
    await expect.poll(async () => (await state()).nativeReads['currency:get']).toBe(1)
    expect(await state()).toMatchObject({
      effectSetups: 2,
      effectCleanups: 1,
      scanCalls: 1,
      nativeReads: expect.objectContaining({
        'scan:start': 1,
        'scan:active': 1,
        'store:status': 1,
        'currency:get': 1,
        'updates:status': 1,
        'coach:harnesses': 1,
      }),
      unexpectedRequests: [],
      attaches: 1,
      listeners: 1,
      rpcConnects: 1,
      lifecycleSubscriptions: 1,
      activeLifecycleSubscriptions: 1,
    })
    await activePage.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          lifecycleProbe: { setCurrency(currency: { code: string; symbol: string; rate: number }): void }
        }
      ).lifecycleProbe.setCurrency({ code: 'EUR', symbol: '€', rate: 0.9 }),
    )
    await expect(activePage.locator('[data-ready="true"]')).toHaveText('€9.00')
    expect((await state()).nativeReads['currency:get']).toBe(1)

    const updateStatus = (revision: number, phase: UpdateStatus['phase']): UpdateStatus => ({
      revision,
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      updateAvailable: true,
      tag: 'v0.3.0',
      phase,
      installSupported: true,
      progress: phase === 'downloading' ? 50 : phase === 'ready' ? 100 : null,
      message: null,
    })
    const updatePane = () =>
      activePage.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & {
            lifecycleProbe: { showUpdatesPane(): void }
          }
        ).lifecycleProbe
        probe.showUpdatesPane()
      })
    const hideUpdatePane = () =>
      activePage.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & {
            lifecycleProbe: { hideUpdatesPane(): void }
          }
        ).lifecycleProbe
        probe.hideUpdatesPane()
      })
    const publishUpdate = (status: UpdateStatus) =>
      activePage.evaluate(status => {
        const probe = (
          globalThis as typeof globalThis & {
            lifecycleProbe: { publishUpdate(status: UpdateStatus): void }
          }
        ).lifecycleProbe
        probe.publishUpdate(status)
      }, status)

    await updatePane()
    await expect(activePage.getByRole('button', { name: 'Check for updates', exact: true })).toBeDisabled()
    await expect(activePage.getByRole('button', { name: 'Open release page' })).toBeVisible()
    await expect(activePage.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
    await expect(activePage.getByRole('button', { name: 'Restart to install', exact: true })).toHaveCount(0)

    await publishUpdate(updateStatus(1, 'available'))
    await expect(activePage.getByRole('button', { name: 'Download update', exact: true })).toBeEnabled()
    await hideUpdatePane()
    await publishUpdate(updateStatus(2, 'downloading'))
    await updatePane()
    await expect(activePage.getByText('Downloading update: 50%')).toBeVisible()

    await publishUpdate(updateStatus(3, 'ready'))
    await expect(activePage.getByRole('button', { name: 'Restart to install', exact: true })).toBeEnabled()
    await expect(activePage.getByText('Version 0.3.0 is ready. Restart to install it.')).toBeVisible()
    await expect(activePage.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
    await hideUpdatePane()
    await publishUpdate(updateStatus(1, 'available'))
    await updatePane()
    await expect(activePage.getByText('Version 0.3.0 is ready. Restart to install it.')).toBeVisible()
    await expect(activePage.getByRole('button', { name: 'Restart to install', exact: true })).toBeEnabled()

    await activePage.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          lifecycleProbe: { dispose(): void }
        }
      ).lifecycleProbe.dispose(),
    )
    await expect.poll(async () => (await state()).nodes).toBe(0)
    expect(await state()).toMatchObject({
      effectCleanups: 2,
      detaches: 1,
      listeners: 0,
      activeLifecycleSubscriptions: 0,
    })
    expect(errors).toEqual([])
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${diagnosticDetails()}\nFixture state:\n${await readFixtureDiagnostics()}`,
    )
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
