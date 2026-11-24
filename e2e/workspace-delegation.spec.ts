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

test('a Delegated Task opens from its parent and reveals the parent in the sidebar', async () => {
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
    const sidebar = window.getByRole('region', { name: 'Chats', exact: true })
    await expect(sidebar.getByRole('button', { name: new RegExp(`^${LIVE}, `) })).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: new RegExp(`^${SETTLED}, `) })).toHaveCount(0)
    // Chats from every Project share one status-grouped list; the card names its Project.
    const parentRow = sidebar.getByRole('button', { name: new RegExp(`^${PARENT}, Delegation fixture, `) })
    // `has` resolves inside each candidate section, so its locator cannot start from the sidebar.
    const parentSection = sidebar
      .getByRole('region')
      .filter({ has: window.getByRole('button', { name: new RegExp(`^${PARENT}, Delegation fixture, `) }) })
    const parentSectionToggle = parentSection.getByRole('button', { name: /^(Expand|Collapse) / })
    await parentRow.click()
    const selected = window.getByRole('region', { name: 'Selected task', exact: true })
    await expect(selected.getByRole('heading', { name: PARENT, exact: true })).toBeVisible()

    // The details panel repeats the "Delegated tasks" section, so the composer strip is scoped to the composer.
    const main = window.getByRole('region', { name: 'Main conversation', exact: true })
    const messages = main.getByRole('region', { name: 'Messages', exact: true })
    const composer = main.getByRole('region', { name: 'Conversation composer', exact: true })
    const strip = composer.getByRole('region', { name: 'Delegated tasks', exact: true })

    // Composer strip: the child settled at reopen has no harness to wake the parent here, so its result is held.
    await expect(strip).toContainText('Result held until you send a message.')
    await expect(strip.getByRole('button', { name: /^Stop delegated task/ })).toHaveCount(0)

    // Timeline: the delegated task is a card that opens the child; a settled child offers no Stop.
    const card = messages.getByRole('button', { name: `Open delegated task ${LIVE}`, exact: true })
    await expect(card).toContainText('Failed')
    await expect(messages.getByRole('button', { name: `Stop delegated task ${LIVE}`, exact: true })).toHaveCount(0)

    // Each settled child's wake is a link to that child, not a message the user wrote.
    await expect(messages.getByRole('button', { name: `${SETTLED} completed`, exact: true })).toHaveCount(1)
    await expect(messages.getByRole('button', { name: `${LIVE} failed`, exact: true })).toHaveCount(1)
    await expect(
      messages.getByRole('article', { name: 'User message', exact: true }).filter({ hasText: 'settled as completed' }),
    ).toHaveCount(0)

    // Details: settled children show their status and a hover card.
    const detailsTrigger = selected.getByRole('button', { name: 'Conversation details', exact: true })
    const details = window
      .getByRole('dialog', { name: 'Conversation details', exact: true })
      .or(window.getByRole('complementary', { name: 'Conversation details', exact: true }))
    const setDetails = async (open: boolean) => {
      if ((await detailsTrigger.getAttribute('aria-expanded')) !== String(open)) await detailsTrigger.click()
    }
    await setDetails(true)
    const lineage = details.getByRole('region', { name: 'Delegated tasks', exact: true })
    await expect(lineage.getByRole('heading')).toHaveText('Delegated tasks')
    // The failed child's result still waits for the parent, so it stays in view; the delivered one folds away.
    const pendingResults = lineage.getByRole('list', { name: 'Pending delegation results', exact: true })
    await expect(pendingResults.getByRole('listitem')).toHaveCount(1)
    await expect(pendingResults).toContainText(LIVE)
    await expect(pendingResults).toContainText('Failed')
    await lineage.getByRole('button', { name: 'Previous tasks (1)', exact: true }).click()
    const previous = lineage.getByRole('list', { name: 'Previous delegated tasks', exact: true })
    await expect(previous.getByRole('listitem')).toHaveCount(1)
    await expect(previous).toContainText(SETTLED)
    await expect(previous).toContainText('Completed')
    await previous.getByRole('button', { name: new RegExp(`^Open delegated task ${SETTLED}`) }).hover()
    const tooltip = window.getByRole('tooltip', { name: /Review the docs.*Status: Completed/ })
    await expect(tooltip).toHaveAttribute('data-side', 'left')
    await expect(tooltip).toHaveCSS('opacity', '1')
    await window.screenshot({ path: test.info().outputPath('delegation-details-tooltip.png') })
    await setDetails(false)
    await expect(details).toBeHidden()

    // Opening a child reveals its parent in the sidebar, and the child links back to the parent.
    await parentSectionToggle.click()
    await expect(parentSectionToggle).toHaveAttribute('aria-expanded', 'false')
    // The strip opens its list on demand unless a delegate needs an answer.
    const stripToggle = strip.getByRole('button', { name: /Details$/ })
    if ((await stripToggle.getAttribute('aria-expanded')) === 'false') await stripToggle.click()
    await strip.getByRole('button', { name: `Open delegated task ${LIVE}`, exact: true }).click()
    await expect(selected.getByRole('heading', { name: LIVE, exact: true })).toBeVisible()
    await expect(parentSectionToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(sidebar.getByRole('button', { name: new RegExp(`^${LIVE}, `) })).toHaveCount(0)
    await expect(selected.getByRole('button', { name: `Open parent task: ${PARENT}`, exact: true })).toBeVisible()
    await expect(messages).toContainText(`Delegated by ${PARENT}`)
    await setDetails(true)
    await expect(details.getByRole('button', { name: `Delegated from ${PARENT}`, exact: true })).toBeVisible()
    await setDetails(false)
    await messages.getByRole('button', { name: PARENT, exact: true }).click()
    await expect(selected.getByRole('heading', { name: PARENT, exact: true })).toBeVisible()

    expect(pageErrors).toEqual([])
  } finally {
    try {
      if (launched) await launched.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
