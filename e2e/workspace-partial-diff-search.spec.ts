import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-partial-diff-search-`))
    throw new Error('Unexpected test directory')
  rmSync(absolute, { recursive: true, force: true })
}

test('find in diff searches a partial patch without full file contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-partial-diff-search-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    // The patch for this change exceeds the inspection budget, so its metadata stays partial.
    const lines = Array.from({ length: 40_000 }, (_, index) => `export const item${index} = "original-value-${index}"`)
    writeFileSync(join(repository, 'large.ts'), `${lines.join('\n')}\n`)
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
      join(repository, 'large.ts'),
      `${lines.map(line => line.replace('original-value', 'changed-value')).join('\n')}\n`,
    )
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
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Diff', exact: true }).click()
    const diff = panel.getByRole('tabpanel')
    await diff.getByRole('button', { name: 'Expand all files', exact: true }).click()
    await expect(diff.locator('[data-line]').first()).toBeVisible({ timeout: 60_000 })
    await diff.getByRole('button', { name: 'Find in diff', exact: true }).click()
    await expect(window.getByText('Something went wrong!', { exact: true })).toBeHidden()
    await diff.getByRole('textbox', { name: 'Search in diff', exact: true }).fill('item42')
    await expect(diff.getByRole('status').last()).toHaveText(/^\d+ \/ \d+\+?$/)
    await expect(window.getByText('Something went wrong!', { exact: true })).toBeHidden()
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeTestDirectory(directory)
  }
})
