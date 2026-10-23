import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { build } from 'vite'

test('development StrictMode shares bootstrap ownership and disposes the window registry', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-lifecycle-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  const mainOutput: string[] = []
  const rendererOutput: string[] = []
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
    const page = await app.firstWindow()
    observePage(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('[data-ready="true"]')).toHaveText('$10.00')
    const state = () =>
      page.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & {
            lifecycleProbe: {
              counts: {
                effectSetups: number
                effectCleanups: number
                scanCalls: number
                currencyReads: number
                attaches: number
                detaches: number
              }
              listeners(): number
              nodes(): number
            }
          }
        ).lifecycleProbe
        return { ...probe.counts, listeners: probe.listeners(), nodes: probe.nodes() }
      })
    await expect.poll(async () => (await state()).currencyReads).toBe(1)
    expect(await state()).toMatchObject({
      effectSetups: 2,
      effectCleanups: 1,
      scanCalls: 1,
      attaches: 10,
      listeners: 10,
    })
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          lifecycleProbe: { setCurrency(currency: { code: string; symbol: string; rate: number }): void }
        }
      ).lifecycleProbe.setCurrency({ code: 'EUR', symbol: '€', rate: 0.9 }),
    )
    await expect(page.locator('[data-ready="true"]')).toHaveText('€9.00')
    expect((await state()).currencyReads).toBe(1)
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          lifecycleProbe: { dispose(): void }
        }
      ).lifecycleProbe.dispose(),
    )
    await expect.poll(async () => (await state()).nodes).toBe(0)
    expect(await state()).toMatchObject({ effectCleanups: 2, detaches: 10, listeners: 0 })
    expect(errors).toEqual([])
  } catch (error) {
    throw new Error(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}${diagnosticDetails()}`)
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
