import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

import { dismissOnboarding, launchApp } from './app'
import { switchVertical } from './verticals'

test('workspace opens recent conversation activity and loads large content in the chat', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-history-'))
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    writeFileSync(join(directory, 'chat-link.txt'), 'CHECKOUT_FILE_LINK_OPENED')
    await build({
      configFile: false,
      resolve: { alias: { '@': resolve('src') } },
      logLevel: 'error',
      build: {
        ssr: resolve('e2e/fixtures/workspace-history-seed.ts'),
        outDir: join(directory, 'seed'),
        emptyOutDir: true,
        rollupOptions: { output: { format: 'es', entryFileNames: 'seed.mjs' } },
      },
    })
    const seed = (await import(
      pathToFileURL(join(directory, 'seed/seed.mjs')).href
    )) as typeof import('./fixtures/workspace-history-seed')
    launched = await launchApp(directory, profile => seed.seedWorkspaceHistory(profile, directory))
    await dismissOnboarding(launched.window)
    const { window } = launched
    await switchVertical(window, 'Workspace')
    const projectGroup = window.getByRole('button', { name: 'History fixture', exact: true })
    if ((await projectGroup.getAttribute('aria-expanded')) === 'false') await projectGroup.click()
    await window.getByRole('button', { name: /Read recent activity/ }).click()
    const history = window.getByRole('region', { name: 'Conversation history' })
    const messages = history.getByRole('region', { name: 'Messages', exact: true })
    await expect(messages.getByText('CURRENT_REPLY_VISIBLE', { exact: true })).toBeVisible()
    await expect(messages.getByText('OLDEST_ACTIVITY_MARKER', { exact: true })).toHaveCount(0)
    await messages.getByRole('link', { name: 'Open chat file', exact: true }).click()
    await expect(window.getByText('CHECKOUT_FILE_LINK_OPENED', { exact: true })).toBeVisible()
    // The audit remains collapsed. Recovery must be available in the primary transcript.
    await messages.getByRole('button', { name: 'Load full content', exact: true }).first().click()
    await expect(messages.getByText(/^FULL_PAYLOAD_RECOVERED/).first()).toBeVisible()
    await switchVertical(window, 'Analytics')
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()
    await switchVertical(window, 'Workspace')
    await expect(window.getByRole('heading', { name: 'Read recent activity', exact: true })).toBeVisible()
    await expect(messages.getByText('CURRENT_REPLY_VISIBLE', { exact: true })).toBeVisible()
    const older = history.getByRole('button', { name: 'Load older messages', exact: true })
    for (let index = 0; index < 5 && (await older.count()); index++) {
      const before = Number(await history.getAttribute('data-history-start'))
      await older.click()
      await expect.poll(async () => Number(await history.getAttribute('data-history-start'))).toBeLessThan(before)
    }
    await expect(older).toHaveCount(0)
    await messages.hover()
    await window.mouse.wheel(0, -1_000_000)
    await expect(messages.getByText('OLDEST_ACTIVITY_MARKER', { exact: true })).toBeVisible()
    await expect.poll(() => messages.evaluate(viewport => viewport.scrollTop)).toBe(0)
    const anchorBefore = await messages.evaluate(viewport => {
      const top = viewport.getBoundingClientRect().top
      return [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')]
        .map(row => ({
          id: row.dataset.messageId,
          top: row.getBoundingClientRect().top - top,
          bottom: row.getBoundingClientRect().bottom - top,
        }))
        .filter(row => row.bottom > 0 && row.top < viewport.clientHeight)
        .sort((left, right) => left.top - right.top)[0]
    })
    await switchVertical(window, 'Analytics')
    await switchVertical(window, 'Workspace')
    await expect(messages.getByText('OLDEST_ACTIVITY_MARKER', { exact: true })).toBeVisible()
    await expect
      .poll(async () =>
        messages.evaluate((viewport, saved) => {
          const row = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            item => item.dataset.messageId === saved?.id,
          )
          return row
            ? Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (saved?.top ?? 0))
            : 999
        }, anchorBefore),
      )
      .toBeLessThan(2)
    const closePanel = window.getByRole('button', { name: 'Close right panel', exact: true })
    if (await closePanel.isVisible()) await closePanel.click()
    await window.setViewportSize({ width: 720, height: 800 })
    const projectNavigation = window.getByRole('button', { name: 'History fixture', exact: true })
    if (!(await projectNavigation.isVisible()))
      await window.getByRole('button', { name: 'Toggle workspace navigation', exact: true }).click()
    await expect(projectNavigation).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.getByRole('heading', { name: 'Read recent activity', exact: true })).toBeVisible()
    expect(launched.pageErrors).toEqual([])
    await window.screenshot({ path: test.info().outputPath('workspace-history.png'), fullPage: true })
    await launched.close()
    launched = undefined
  } finally {
    await launched?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
