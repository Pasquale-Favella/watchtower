import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-files-diff-`))
    throw new Error('Unexpected test directory')
  rmSync(absolute, { recursive: true, force: true })
}

test('files and diffs support continuous review and navigation through a side explorer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-files-diff-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    mkdirSync(join(repository, 'src'))
    mkdirSync(join(repository, 'lib'))
    mkdirSync(join(repository, '.cache'))
    writeFileSync(join(repository, '.gitignore'), '.cache/\n')
    writeFileSync(join(repository, '.cache', 'local.txt'), 'Ignored local file\n')
    writeFileSync(
      join(repository, 'table.csv'),
      `name,value\n${Array.from({ length: 201 }, (_, index) => `Entry ${index + 1},${index + 1}`).join('\n')}\n`,
    )
    writeFileSync(join(repository, 'lib', 'helper.ts'), 'export const helper = true\n')
    writeFileSync(join(repository, 'README.md'), '# Fixture\nOriginal readme\n')
    writeFileSync(join(repository, 'src', 'example.ts'), 'export const value = 1\n')
    writeFileSync(join(repository, 'deleted.ts'), 'export const removedFile = true\n')
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
    writeFileSync(
      join(repository, 'README.md'),
      '# Fixture\nChanged readme\n\n- [ ] Parent\n  - [ ] Nested\n\n[Open example](src/example.ts)\n',
    )
    writeFileSync(join(repository, 'src', 'example.ts'), 'export const value = 2\n')
    writeFileSync(join(repository, 'added.ts'), 'export const addedFile = true\n')
    unlinkSync(join(repository, 'deleted.ts'))
    launched = await launchApp(directory)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
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
    let active = panel.getByRole('tabpanel')
    await active.getByRole('button', { name: 'Expand all folders', exact: true }).click()
    await expect(active.locator('button[data-item-path="src/example.ts"]')).toBeVisible()
    await expect(active.locator('button[data-item-path="lib/helper.ts"]')).toBeVisible()
    await expect(active.locator('button[data-item-path=".cache/"]')).toBeVisible()
    await expect(active.locator('button[data-item-path=".cache/local.txt"]')).toBeHidden()
    await active.locator('button[data-item-path=".cache/"]').click()
    await expect(active.locator('button[data-item-path=".cache/local.txt"]')).toBeVisible()
    await active.getByRole('button', { name: 'Collapse all folders', exact: true }).click()
    await expect(active.locator('button[data-item-path="src/example.ts"]')).toBeHidden()
    await active.getByRole('searchbox', { name: 'Search files', exact: true }).fill('example')
    await active.locator('button[data-item-path="src/example.ts"]').click()
    active = panel.getByRole('tabpanel')
    await expect(active.locator('[data-line]').filter({ hasText: 'export const value = 2' })).toBeVisible()
    const explorer = active.getByRole('complementary', { name: 'File explorer', exact: true })
    await expect(explorer.locator('button[data-item-path="src/example.ts"]')).toHaveAttribute('aria-selected', 'true')
    const sourceDirectory = explorer.locator('button[data-item-path="src/"]')
    await expect(sourceDirectory).toHaveAttribute('aria-expanded', 'true')
    await sourceDirectory.click()
    await expect(sourceDirectory).toHaveAttribute('aria-expanded', 'false')
    await explorer.getByRole('button', { name: 'Refresh files', exact: true }).click()
    await expect(sourceDirectory).toHaveAttribute('aria-expanded', 'false')
    await window.screenshot({ path: test.info().outputPath('file-explorer.png') })
    const resize = explorer.getByRole('separator', { name: 'Resize file explorer', exact: true })
    const width = Number(await resize.getAttribute('aria-valuenow'))
    await resize.press('ArrowLeft')
    await expect(resize).toHaveAttribute('aria-valuenow', String(width + 16))
    await active.getByRole('button', { name: 'Hide file tree', exact: true }).click()
    await expect(explorer).toBeHidden()
    await active.getByRole('button', { name: 'Show file tree', exact: true }).click()
    await expect(sourceDirectory).toHaveAttribute('aria-expanded', 'false')
    await explorer.locator('button[data-item-path="README.md"]').click()
    await expect(panel.getByRole('tabpanel').getByText('Changed readme', { exact: true })).toBeVisible()
    active = panel.getByRole('tabpanel')
    await active.getByRole('checkbox').nth(1).check()
    await expect(active.getByRole('checkbox').nth(0)).not.toBeChecked()
    await expect
      .poll(() => readFileSync(join(repository, 'README.md'), 'utf8'))
      .toContain('- [ ] Parent\n  - [x] Nested')
    await active.getByRole('link', { name: 'Open example', exact: true }).click()
    await expect(panel.getByRole('tab', { name: 'example.ts', exact: true })).toHaveAttribute('aria-selected', 'true')
    await panel.getByRole('tab', { name: 'README.md', exact: true }).click()
    await panel
      .getByRole('tabpanel')
      .getByRole('complementary', { name: 'File explorer', exact: true })
      .locator('button[data-item-path="table.csv"]')
      .click()
    active = panel.getByRole('tabpanel')
    await expect(active.getByRole('cell', { name: 'Entry 1', exact: true })).toBeVisible()
    await active.getByRole('button', { name: 'Next table rows', exact: true }).click()
    await expect(active.getByRole('cell', { name: 'Entry 150', exact: true })).toBeVisible()
    await expect(active.getByRole('cell', { name: 'Entry 1', exact: true })).toBeHidden()
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Diff', exact: true }).click()
    active = panel.getByRole('tabpanel')
    await expect(active.getByRole('button', { name: 'Expand all files', exact: true })).toBeVisible()
    await expect(active.locator('[data-line]').filter({ hasText: 'Changed readme' })).toBeHidden()
    await active.getByRole('button', { name: 'Expand all files', exact: true }).click()
    await expect(active.locator('[data-line]').filter({ hasText: 'Changed readme' })).toBeVisible()
    await expect(active.locator('[data-line]').filter({ hasText: 'export const value = 2' })).toBeVisible()
    await expect(active.locator('[data-line]').filter({ hasText: 'export const addedFile = true' })).toBeVisible()
    await expect(active.locator('[data-line]').filter({ hasText: 'export const removedFile = true' })).toBeVisible()
    await expect(active.getByText('Invalid result for preview operation "process".', { exact: true })).toBeHidden()
    await active.getByRole('button', { name: 'Collapse all files', exact: true }).click()
    await expect(active.locator('[data-line]').filter({ hasText: 'Changed readme' })).toBeHidden()
    await active.getByRole('button', { name: 'Show file tree', exact: true }).click()
    await active
      .getByRole('complementary', { name: 'File explorer', exact: true })
      .locator('button[data-item-path="src/example.ts"]')
      .click()
    await expect(active.locator('[data-line]').filter({ hasText: 'export const value = 2' })).toBeVisible()
    await expect(active.getByRole('button', { name: 'Collapse src/example.ts', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await active.getByRole('button', { name: 'Split diff view', exact: true }).click()
    await expect(active.locator('[data-diff-type="split"]').first()).toBeVisible()
    await window.screenshot({ path: test.info().outputPath('continuous-diff.png') })
    await active.getByRole('button', { name: 'Collapse all files', exact: true }).click()
    await active.getByRole('button', { name: 'Find in diff', exact: true }).click()
    const search = active.locator('[data-search-panel] input').first()
    await search.fill('Changed readme')
    await expect(active.locator('[data-line]').filter({ hasText: 'Changed readme' })).toBeVisible()
    await search.press('Escape')
    await active.locator('[data-title]').filter({ hasText: 'README.md' }).first().click()
    await expect(panel.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeTestDirectory(directory)
  }
})
