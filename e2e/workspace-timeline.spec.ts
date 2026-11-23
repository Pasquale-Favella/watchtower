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
    const rail = page.getByRole('button', { name: /^Jump to message:/ })
    await expect(rail).toBeVisible()
    // The user message aligned at the jump inset, once the glide has settled.
    const aligned = () =>
      messages.evaluate(viewport => {
        const top = viewport.getBoundingClientRect().top
        const row = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(element => {
          const offset = element.getBoundingClientRect().top - top
          return offset > 20 && offset < 28
        })
        return row ? Number(row.dataset.messageId?.replace('message-', '')) : null
      })
    const previous = page.getByRole('button', { name: 'Previous message', exact: true })
    const next = page.getByRole('button', { name: 'Next message', exact: true })
    // Real pointer input at the control, the way a reader clicks it.
    const press = async (control: Locator) => {
      const box = await control.boundingBox()
      if (!box) throw new Error('Minimap control is not laid out')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    const pressWithoutShifting = async (control: Locator) => {
      await control.hover()
      const positions = () =>
        control.evaluate(button => ({
          button: button.getBoundingClientRect().top,
          icon: button.querySelector('svg')?.getBoundingClientRect().top,
        }))
      const before = await positions()
      await page.mouse.down()
      const pressed = await positions()
      await page.mouse.up()
      expect(pressed).toEqual(before)
      expect(await positions()).toEqual(before)
    }
    await page.evaluate(() => {
      const w = window as unknown as { dbg: string[] }
      w.dbg = []
      document.addEventListener('pointerup', event => {
        const b = document.querySelector<HTMLElement>('[aria-label="Previous message"]')
        const s = b && getComputedStyle(b)
        w.dbg.push('UP pe=' + s?.pointerEvents + ' disp=' + s?.display + ' vis=' + s?.visibility + ' tf=' + s?.transform + ' stack=' + document.elementsFromPoint(event.clientX, event.clientY).slice(0, 4).map(e => e.tagName + '.' + (e.getAttribute('data-slot') ?? e.getAttribute('aria-label') ?? '')).join('|') + ' cap=' + String((event.target as Element).hasPointerCapture?.(event.pointerId)))
      }, true)
      for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'click'])
        document.addEventListener(type, event => w.dbg.push(type + ':' + ((event.target as HTMLElement).getAttribute?.('aria-label') ?? (event.target as HTMLElement).tagName + '.' + String((event.target as HTMLElement).className).slice(0, 60) + '#' + ((event.target as HTMLElement).dataset?.slot ?? '')) + ':' + (event as MouseEvent).clientX + ',' + (event as MouseEvent).clientY), true)
    })
    await pressWithoutShifting(previous)
    console.log('DBG4', JSON.stringify(await page.evaluate(() => (window as unknown as { dbg: string[] }).dbg)), JSON.stringify(await previous.boundingBox()))
    await expect.poll(aligned).not.toBeNull()
    const first = Number(await aligned())
    // Rapid presses keep stepping from the destination instead of re-targeting mid-glide.
    await press(previous)
    await press(previous)
    await expect.poll(aligned).toBe(first - 50)
    await pressWithoutShifting(next)
    await expect.poll(aligned).toBe(first - 25)
    await rail.hover()
    const preview = page.getByRole('tooltip', { name: /A reply preview\./ })
    await expect(preview).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('workspace-timeline-minimap.png') })
    await messages.hover()
    await next.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(rail).toBeFocused()
    await rail.press('Home')
    await expect(preview).toContainText('Message -80')
    const firstPreviewY = (await preview.boundingBox())?.y ?? 0
    await rail.press('End')
    await expect(preview).toContainText('Message 295')
    await expect.poll(async () => (await preview.boundingBox())?.y ?? 0).toBeGreaterThan(firstPreviewY + 24)
    await rail.press('Escape')
    await expect(preview).toBeHidden()
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('workspace-timeline.png') })
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
