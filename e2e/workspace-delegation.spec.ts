import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from '@playwright/test'
import { build } from 'vite'

import { dismissOnboarding, launchApp } from './app'
import { switchVertical } from './verticals'

const PARENT = 'Coordinate the audit'
const LIVE = 'Audit the parser'
const SETTLED = 'Review the docs'

test('a parent Task shows its delegated tasks, which open, nest in the sidebar and stop from the UI', async () => {
  test.setTimeout(180_000)
  // Under the repo root, so the bundled seed resolves its own dependencies from node_modules.
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-delegation-'))
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    await build({
      configFile: false,
      resolve: { alias: { '@': resolve('src') } },
      logLevel: 'error',
      build: {
        ssr: resolve('e2e/fixtures/workspace-delegation-seed.ts'),
        outDir: join(directory, 'seed'),
        emptyOutDir: true,
        rollupOptions: { output: { format: 'es', entryFileNames: 'seed.mjs' } },
      },
    })
    const seed = (await import(
      pathToFileURL(join(directory, 'seed/seed.mjs')).href
    )) as typeof import('./fixtures/workspace-delegation-seed')
    launched = await launchApp(directory, profile => seed.seedWorkspaceDelegation(profile, directory))
    await dismissOnboarding(launched.window)
    const { window, pageErrors } = launched

    await switchVertical(window, 'Workspace')
    const projectGroup = window.getByRole('button', { name: 'Delegation fixture', exact: true })
    if ((await projectGroup.getAttribute('aria-expanded')) === 'false') await projectGroup.click()

    // Children are nested under their parent, never listed as top-level rows.
    await expect(window.getByRole('button', { name: new RegExp(`^${LIVE}, `) })).toHaveCount(0)
    // The task row's name starts with its title; the delegates toggle's label also contains it, so match the row.
    await window.getByRole('button', { name: new RegExp(`^${PARENT}, `) }).click()
    const selected = window.getByRole('region', { name: 'Selected task', exact: true })
    await expect(selected.getByRole('heading', { name: PARENT, exact: true })).toBeVisible()

    // The details panel repeats the "Delegated tasks" section, so the composer strip is scoped to the composer.
    const main = window.getByRole('region', { name: 'Main conversation', exact: true })
    const messages = main.getByRole('region', { name: 'Messages', exact: true })
    const composer = main.getByRole('region', { name: 'Conversation composer', exact: true })
    const strip = composer.getByRole('region', { name: 'Delegated tasks', exact: true })

    // Composer strip: the child settled at reopen has no harness to wake the parent here, so its result is held.
    await expect(strip).toContainText('Result held until you send a message.')
    await expect(strip.getByRole('button', { name: new RegExp(`^Stop delegated task`) })).toHaveCount(0)

    // Timeline: the delegation tool call is a row that links to the child and can be stopped.
    const timelineRow = messages.getByRole('button', { name: new RegExp(LIVE) }).first()
    await expect(timelineRow).toContainText('Failed')
    await expect(messages.getByRole('button', { name: `Open delegated task ${LIVE}`, exact: true })).toBeVisible()
    await expect(messages.getByRole('button', { name: `Stop delegated task ${LIVE}`, exact: true })).toHaveCount(0)

    // The settled child's wake is a notice, not a message the user wrote.
    const notices = messages.getByRole('article', { name: 'Delegated task settled', exact: true })
    await expect(notices.filter({ hasText: `Delegated task ${SETTLED} settled as completed` })).toHaveCount(1)
    await expect(notices.filter({ hasText: `Delegated task ${LIVE} settled as failed` })).toHaveCount(1)
    await expect(
      messages.getByRole('article', { name: 'User message', exact: true }).filter({ hasText: 'settled as completed' }),
    ).toHaveCount(0)

    // Details: both children are listed with their status. The panel may start open, so set it open before reading.
    const detailsTrigger = selected.getByRole('button', { name: 'Conversation details', exact: true })
    const details = window
      .getByRole('dialog', { name: 'Conversation details', exact: true })
      .or(window.getByRole('complementary', { name: 'Conversation details', exact: true }))
    const setDetails = async (open: boolean) => {
      if ((await detailsTrigger.getAttribute('aria-expanded')) !== String(open)) await detailsTrigger.click()
    }
    await setDetails(true)
    const list = details.getByRole('list', { name: 'Delegated task list', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list).toContainText(LIVE)
    await expect(list).toContainText('Failed')
    await expect(list).toContainText(SETTLED)
    await expect(list).toContainText('Completed')
    await setDetails(false)
    await expect(details).toBeHidden()

    // Sidebar: the children appear only under the parent's expanded delegates.
    await window.getByRole('button', { name: `Expand delegated tasks of ${PARENT}, 2 total`, exact: true }).click()
    await expect(window.getByRole('button', { name: `${LIVE}, Failed`, exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: `${SETTLED}, Completed`, exact: true })).toBeVisible()

    // Open navigates to the child, which offers to return to its parent.
    await strip.getByRole('button', { name: `Open delegated task ${LIVE}`, exact: true }).click()
    await expect(selected.getByRole('heading', { name: LIVE, exact: true })).toBeVisible()
    const context = window.getByRole('region', { name: 'Delegated task context', exact: true })
    await expect(context).toContainText('Runs on its own · Failed')
    await context.getByRole('button', { name: 'Open parent', exact: true }).click()
    await expect(selected.getByRole('heading', { name: PARENT, exact: true })).toBeVisible()

    await setDetails(true)
    await expect(details.getByRole('list', { name: 'Delegated task list', exact: true })).toContainText('Failed')

    expect(pageErrors).toEqual([])
  } finally {
    try {
      if (launched) await launched.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
