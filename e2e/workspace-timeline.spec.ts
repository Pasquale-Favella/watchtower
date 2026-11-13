import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, type Locator, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

type ReadingAnchor = { readonly id: string; readonly top: number; readonly bottom: number }

async function readingAnchor(messages: Locator): Promise<ReadingAnchor> {
  const anchor = await messages.evaluate(viewport => {
    const top = viewport.getBoundingClientRect().top
    const visible = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')]
      .map(row => ({
        id: row.dataset.messageId ?? '',
        top: row.getBoundingClientRect().top - top,
        bottom: row.getBoundingClientRect().bottom - top,
      }))
      .filter(row => row.bottom > 0 && row.top < viewport.clientHeight)
      .sort((a, b) => a.top - b.top)
    return visible[0]
  })
  if (!anchor) throw new Error('The timeline has no visible message')
  return anchor
}

test('chat virtualizes variable heights and holds the reader through streaming, prepends and conversation switches', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-timeline-'))
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
        outDir: join(directory, 'renderer'),
        rollupOptions: { input: resolve('e2e/fixtures/workspace-timeline.html') },
      },
    })
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('e2e/fixtures/workspace-timeline-main.mjs'),
        join(directory, 'renderer/workspace-timeline.html'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const messages = page.getByRole('region', { name: 'Messages', exact: true })
    const gap = () => messages.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)
    await expect(messages.getByText('Message 299', { exact: true })).toBeVisible()
    await expect.poll(gap).toBeLessThanOrEqual(8)
    await expect.poll(() => messages.locator('[data-message-id]').count()).toBeLessThan(40)
    const link = messages.getByRole('link', { name: 'Reference', exact: true })
    await link.evaluate(node => node.setAttribute('data-instance', 'retained'))
    await page.getByRole('button', { name: 'Start streaming', exact: true }).click()
    await expect.poll(async () => Number(await page.getByLabel('Chunks').textContent())).toBeGreaterThan(10)
    await expect.poll(gap).toBeLessThanOrEqual(8)
    await expect(link).toHaveAttribute('data-instance', 'retained')
    await page.getByRole('button', { name: 'Stop streaming', exact: true }).click()

    await messages.hover()
    await page.mouse.wheel(0, -1000)
    await expect(page.getByRole('button', { name: 'Scroll to end', exact: true })).toBeVisible()
    const anchor = await readingAnchor(messages)
    await page.getByRole('button', { name: 'Start streaming', exact: true }).click()
    const before = Number(await page.getByLabel('Chunks').textContent())
    await expect.poll(async () => Number(await page.getByLabel('Chunks').textContent())).toBeGreaterThan(before + 10)
    expect((await readingAnchor(messages)).id).toBe(anchor.id)
    expect(Math.abs((await readingAnchor(messages)).top - anchor.top)).toBeLessThan(2)
    await page.getByRole('button', { name: 'Stop streaming', exact: true }).click()

    await page.getByRole('button', { name: 'Prepend history', exact: true }).click()
    await expect.poll(() => readingAnchor(messages)).toMatchObject({ id: anchor.id })
    await expect.poll(async () => Math.abs((await readingAnchor(messages)).top - anchor.top)).toBeLessThan(2)
    await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
    await expect(messages.getByText('Message 1000', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
    await expect.poll(async () => (await readingAnchor(messages)).id).toBe(anchor.id)
    await expect.poll(async () => Math.abs((await readingAnchor(messages)).top - anchor.top)).toBeLessThan(2)

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: 'Scroll to end', exact: true }).click()
    await expect.poll(gap).toBeLessThanOrEqual(8)
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).press('PageUp')
    await expect(page.getByRole('button', { name: 'Scroll to end', exact: true })).toBeVisible()
    await expect.poll(gap).toBeGreaterThan(200)
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('workspace-timeline.png') })
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
