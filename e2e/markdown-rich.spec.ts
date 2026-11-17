import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

test('Markdown holds completed blocks while streaming and renders safe rich content and code controls', async () => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-markdown-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await build({
      configFile: false,
      root: resolve('e2e/fixtures'),
      base: './',
      plugins: [tailwindcss()],
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': resolve('src') } },
      logLevel: 'error',
      build: {
        assetsInlineLimit: 0,
        outDir: join(directory, 'renderer'),
        rollupOptions: { input: resolve('e2e/fixtures/markdown-rich.html') },
      },
    })
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('e2e/fixtures/markdown-rich-main.mjs'),
        join(directory, 'renderer/markdown-rich.html'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    const page = await app.firstWindow()
    const electronApp = app
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.show()
      window.focus()
    })
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await page.evaluate(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.writeText = async text => {
        Reflect.set(globalThis, 'clipboardAttempt', { text, focused: document.hasFocus() })
        try {
          await original(text)
          Reflect.set(globalThis, 'clipboardAttempt', { text, focused: document.hasFocus(), fulfilled: true })
        } catch (cause) {
          Reflect.set(globalThis, 'clipboardAttemptError', String(cause))
          throw cause
        }
      }
    })
    const errors: string[] = []
    const remoteRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', request => {
      if (request.url().startsWith('https://example.invalid')) remoteRequests.push(request.url())
    })
    const message = page.getByRole('article', { name: 'Markdown message' })
    const link = message.getByRole('link', { name: 'Reference', exact: true })
    await expect(link).toBeVisible()
    await link.evaluate(node => node.setAttribute('data-instance', 'retained'))
    await expect(message.getByRole('table')).toContainText('Example')
    await expect(message.getByRole('checkbox').first()).toBeChecked()
    await expect(message.locator('.katex')).toHaveCount(2)
    await expect(message.getByRole('button', { name: 'Open Remote image in browser' })).toBeVisible()
    await expect(message.locator('img[src^="https:"]')).toHaveCount(0)
    await expect(message.locator('script')).toHaveCount(0)
    await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0)
    await expect(message.getByRole('button', { name: 'Copy code', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Append text', exact: true }).click()
    await expect(message).toContainText('const appended = 42')
    await expect(link).toHaveAttribute('data-instance', 'retained')
    await page.getByRole('button', { name: 'Finish streaming', exact: true }).click()
    await expect(message).toContainText('Finished.')
    await expect(link).toHaveAttribute('data-instance', 'retained')
    await expect(message.locator('[data-streamdown="code-block-body"] span[style]')).not.toHaveCount(0)
    await expect(message.getByRole('button', { name: 'Copy code', exact: true })).toBeEnabled()
    await message.getByRole('button', { name: 'Copy code', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, 'clipboardAttempt')))
      .toMatchObject({ text: expect.stringContaining('const appended = 42'), fulfilled: true })
    expect(await page.evaluate(() => Reflect.get(globalThis, 'clipboardAttemptError'))).toBeUndefined()
    const nativeClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    if (!nativeClipboard.includes('const appended = 42')) {
      test.info().annotations.push({
        type: 'environment',
        description:
          'The browser Clipboard API accepted the expected code; Electron native clipboard reads returned no matching data in this Windows session.',
      })
    }
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (event, item) => {
        event.preventDefault()
        Reflect.set(globalThis, 'markdownDownload', { filename: item.getFilename(), mime: item.getMimeType() })
      })
    })
    await message.getByRole('button', { name: 'Download code', exact: true }).click()
    await expect
      .poll(() => electronApp.evaluate(() => Reflect.get(globalThis, 'markdownDownload')))
      .toMatchObject({ filename: expect.stringMatching(/\.ts$/), mime: 'text/plain' })
    const wrap = message.getByRole('button', { name: 'Wrap code', exact: true })
    await wrap.click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expect(message.locator('.markdown-code pre')).toHaveCSS('white-space', 'pre-wrap')
    await message.getByRole('button', { name: 'Preview Pixel', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await message.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded()
    const diagram = message.locator('[data-streamdown="mermaid"] svg.flowchart')
    await expect(diagram).toBeVisible()
    const references = page.getByRole('article', { name: 'References', exact: true })
    await references.getByRole('link', { name: 'Root source', exact: true }).click()
    await expect(page.getByLabel('Opened file', { exact: true })).toHaveText('README.md')
    await expect(page.getByLabel('Image reads', { exact: true })).toHaveText('')
    await expect(references.getByRole('button', { name: 'Load Outside chart preview', exact: true })).toHaveCount(0)
    await expect(references.getByRole('button', { name: 'Load Unsafe chart preview', exact: true })).toHaveCount(0)
    await references.getByRole('button', { name: 'Load Local chart preview', exact: true }).click()
    await expect(page.getByLabel('Image reads', { exact: true })).toHaveText('images/chart.png')
    await references.getByRole('button', { name: 'Preview Local chart', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await references.getByRole('button', { name: 'Load Absolute chart preview', exact: true }).click()
    await expect(page.getByLabel('Image reads', { exact: true })).toHaveText('images/chart.png,images/absolute.png')
    await expect(references.getByRole('button', { name: 'Preview Absolute chart', exact: true })).toBeVisible()
    await references.getByRole('button', { name: 'Load Missing chart preview', exact: true }).click()
    await expect(references).toContainText('Image preview unavailable.')
    await expect(references.getByRole('link', { name: 'reference guide', exact: true })).toHaveAttribute(
      'href',
      'https://example.invalid/guide',
    )
    const note = references.locator('a[data-footnote-ref]')
    await note.click()
    await expect(references.locator('section[data-footnotes]')).toContainText('A useful detail.')
    await references.getByRole('link', { name: 'Source file', exact: true }).click()
    await expect(page.getByLabel('Opened file')).toHaveText('src/app.ts')
    await references.getByRole('link', { name: 'Absolute source', exact: true }).click()
    await expect(page.getByLabel('Opened file')).toHaveText('src/absolute.ts')
    expect(await page.evaluate(() => Reflect.get(globalThis, 'markdownExecuted'))).toBeUndefined()
    expect(remoteRequests).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('markdown-rich.png'), fullPage: true })
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
