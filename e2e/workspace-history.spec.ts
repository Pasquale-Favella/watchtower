import { mkdtempSync, rmSync } from 'node:fs'
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
    // The audit remains collapsed. Recovery must be available in the primary transcript.
    await messages.getByRole('button', { name: 'Load full content', exact: true }).first().click()
    await expect(messages.getByText(/^FULL_PAYLOAD_RECOVERED/).first()).toBeVisible()
    await switchVertical(window, 'Analytics')
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()
    await switchVertical(window, 'Workspace')
    await expect(window.getByRole('heading', { name: 'Read recent activity', exact: true })).toBeVisible()
    await expect(messages.getByText('CURRENT_REPLY_VISIBLE', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: 'Toggle workspace navigation', exact: true }).first().click()
    await window.setViewportSize({ width: 720, height: 800 })
    await window.getByRole('button', { name: 'Toggle workspace navigation', exact: true }).click()
    await expect(window.getByRole('button', { name: 'History fixture', exact: true })).toBeVisible()
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
