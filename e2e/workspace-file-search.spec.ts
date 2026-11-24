import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-file-search-`))
    throw new Error('Unexpected test directory')
  rmSync(absolute, { recursive: true, force: true })
}

test('explorer search over unlisted folders keeps the tree and both tabs usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-file-search-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    mkdirSync(join(repository, 'packages', 'deep', 'src'), { recursive: true })
    mkdirSync(join(repository, 'src'))
    writeFileSync(join(repository, 'root.ts'), 'export const root = true\n')
    writeFileSync(join(repository, 'src', 'index.ts'), 'export const index = true\n')
    writeFileSync(join(repository, 'packages', 'deep', 'src', 'module.ts'), 'export const nested = true\n')
    execFileSync('git', ['add', '.'], { cwd: repository, windowsHide: true, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Fixture',
      ],
      { cwd: repository, windowsHide: true, stdio: 'pipe' },
    )
    writeFileSync(join(repository, 'root.ts'), 'export const root = 2\n')
    launched = await launchApp(directory)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: /^Add project/ }).click()
    const dialog = window.getByRole('dialog', { name: 'Add project', exact: true })
    await dialog.getByRole('option', { name: /^Local folder/ }).click()
    await dialog.getByRole('combobox', { name: 'Project folder', exact: true }).fill(repository)
    await dialog.getByRole('button', { name: /^Add \(/ }).click()
    await window
      .locator('header[aria-label="Chat header"]')
      .getByRole('button', { name: 'Right panel', exact: true })
      .click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await panel.getByRole('button', { name: 'Files', exact: true }).click()
    const files = panel.getByRole('tabpanel')
    await expect(files.locator('button[data-item-path="packages/"]')).toBeVisible()
    const search = files.getByRole('searchbox', { name: 'Search files', exact: true })
    // Each query adds paths under folders the explorer never listed, then widens the result set.
    for (const query of ['packages', 'src', 'deep', 'module', 'ts']) {
      await search.fill(query)
      await window.waitForTimeout(1200)
    }
    await expect(window.getByText('Something went wrong!', { exact: true })).toBeHidden()
    await search.fill('module')
    await files.locator('button[data-item-path="packages/deep/src/module.ts"]').click()
    await expect(files.locator('[data-line]').filter({ hasText: 'export const nested = true' })).toBeVisible()
    await search.fill('')
    const explorer = files.getByRole('complementary', { name: 'File explorer', exact: true })
    await expect(explorer.locator('button[data-item-path="packages/deep/src/module.ts"]')).toBeVisible()
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Diff', exact: true }).click()
    const diff = panel.getByRole('tabpanel')
    await diff.getByRole('button', { name: 'Expand all files', exact: true }).click()
    await expect(diff.locator('[data-line]').filter({ hasText: 'export const root = 2' })).toBeVisible()
    await diff.getByRole('button', { name: 'Find in diff', exact: true }).click()
    await diff.getByRole('textbox', { name: 'Search in diff', exact: true }).fill('root')
    await expect(diff.getByRole('status').last()).toContainText('/')
    await diff.getByRole('button', { name: 'Show file tree', exact: true }).click()
    await expect(
      diff
        .getByRole('complementary', { name: 'File explorer', exact: true })
        .locator('button[data-item-path="root.ts"]'),
    ).toBeVisible()
    await expect(window.getByText('Something went wrong!', { exact: true })).toBeHidden()
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeTestDirectory(directory)
  }
})
