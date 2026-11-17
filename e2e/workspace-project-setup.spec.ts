import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', windowsHide: true })
    .toString()
    .trim()

test('add project creates, initializes and clones local repositories without GitHub', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-setup-'))
  const remote = join(directory, 'remotes', 'origin-repo')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    mkdirSync(remote, { recursive: true })
    git(remote, 'init', '--quiet')
    git(
      remote,
      '-c',
      'user.name=Setup Test',
      '-c',
      'user.email=setup@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'Remote fixture',
    )
    launched = await launchApp(directory)
    const { window } = launched
    await dismissOnboarding(window)
    const picker = window.getByRole('combobox', { name: 'Project', exact: true })
    const addProject = window.getByRole('dialog', { name: 'Add project' })
    const openAddProject = async () => {
      await picker.click()
      await window.getByRole('option', { name: 'Add project', exact: true }).click()
      await expect(addProject).toBeVisible()
    }

    await openAddProject()
    await addProject.getByRole('option', { name: /^Local folder/ }).click()
    const folder = addProject.getByRole('combobox', { name: 'Project folder', exact: true })
    await folder.fill(join(directory, 'made-here'))
    const createAndAdd = addProject.getByRole('button', { name: 'Create & Add (Enter)', exact: true })
    await expect(createAndAdd).toBeEnabled()
    await folder.press('Enter')
    await expect(addProject).toHaveCount(0)
    await expect(picker).toHaveText('made-here')
    expect(git(join(directory, 'made-here'), 'rev-parse', '--is-inside-work-tree')).toBe('true')

    await openAddProject()
    await addProject.getByRole('option', { name: /^Local folder/ }).click()
    await folder.fill(`${directory}${sep}`)
    await expect(addProject.getByRole('option', { name: 'made-here', exact: true })).toBeVisible()
    await addProject.getByRole('button', { name: 'Back', exact: true }).click()
    await addProject.getByRole('option', { name: /^New project/ }).click()
    const name = addProject.getByRole('combobox', { name: 'Project name', exact: true })
    await name.fill('fresh-app')
    await expect(addProject.getByText(`Creates ${join(directory, 'fresh-app')}`, { exact: true })).toBeVisible()
    await name.press('Enter')
    await expect(addProject).toHaveCount(0)
    await expect(picker).toHaveText('fresh-app')

    await openAddProject()
    await addProject.getByRole('option', { name: /^Clone from Git URL/ }).click()
    const url = addProject.getByRole('combobox', { name: 'Git URL', exact: true })
    await url.fill(remote)
    await url.press('Enter')
    const destination = addProject.getByRole('combobox', { name: 'Project folder', exact: true })
    await expect(destination).toHaveValue(`~/origin-repo`)
    await destination.fill(join(directory, 'origin-repo'))
    await expect(addProject.getByRole('button', { name: 'Clone (Enter)', exact: true })).toBeEnabled()
    await destination.press('Enter')
    await expect(addProject).toHaveCount(0)
    await expect(picker).toHaveText('origin-repo')
    expect(git(join(directory, 'origin-repo'), 'log', '--format=%s')).toBe('Remote fixture')

    await openAddProject()
    await addProject.getByRole('option', { name: /^Clone from Git URL/ }).click()
    await url.fill(remote)
    await url.press('Enter')
    await destination.fill(join(directory, 'made-here'))
    await destination.press('Enter')
    await expect(addProject.getByRole('alert')).toHaveText('The destination folder is not empty.')
    expect(launched.pageErrors).toEqual([])
  } finally {
    if (launched?.pageErrors.length)
      await test.info().attach('renderer-errors', {
        body: launched.pageErrors.map(error => error.stack ?? error.message).join('\n'),
        contentType: 'text/plain',
      })
    await launched?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
