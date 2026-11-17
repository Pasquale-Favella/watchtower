import { expect, test } from '@playwright/test'

import { dismissOnboarding, withApp } from './app'
import { switchVertical } from './verticals'

test('Workspace opens by default and the vertical switcher scopes Analytics commands', async () => {
  await withApp(async ({ window }) => {
    await dismissOnboarding(window)
    await expect(window.getByRole('main', { name: 'Agent workspace' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Switch application, Workspace' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Workspace', exact: true })).toHaveCount(0)
    await switchVertical(window, 'Analytics')
    await window.keyboard.press('ControlOrMeta+6')
    await expect(window.getByRole('tab', { name: 'By model' })).toBeVisible()

    await switchVertical(window, 'Workspace')
    const workspace = window.getByRole('main', { name: 'Agent workspace' })
    await expect(workspace).toBeVisible()
    await expect(window.getByRole('button', { name: 'Open Project', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Overview', exact: true })).toHaveCount(0)

    await window.keyboard.press('ControlOrMeta+1')
    await window.keyboard.press('ControlOrMeta+9')
    await window.keyboard.press('ControlOrMeta+k')
    await expect(workspace).toBeVisible()
    await expect(window.getByPlaceholder('Go to a section or run an action...')).toHaveCount(0)

    await window.keyboard.press('ControlOrMeta+b')
    await expect(window.getByRole('button', { name: 'Open Project', exact: true })).toBeHidden()
    const switcher = window.getByRole('button', { name: 'Switch application, Workspace' })
    await expect(switcher).toHaveCSS('width', '32px')
    const logoFits = await switcher.evaluate(button => {
      const mark = button.querySelector('svg')
      if (!mark) return false
      const logo = mark.getBoundingClientRect()
      const bounds = button.getBoundingClientRect()
      return (
        logo.left >= bounds.left && logo.right <= bounds.right && logo.top >= bounds.top && logo.bottom <= bounds.bottom
      )
    })
    expect(logoFits).toBe(true)
    await window.screenshot({ path: test.info().outputPath('workspace-collapsed.png'), fullPage: true })
    await switchVertical(window, 'Analytics')
    await expect(window.getByRole('tab', { name: 'By model' })).toBeVisible()
    await window.keyboard.press('ControlOrMeta+b')
    await expect(window.getByRole('button', { name: 'Overview', exact: true })).toBeVisible()
    await window.keyboard.press('ControlOrMeta+k')
    await expect(window.getByPlaceholder('Go to a section or run an action...')).toBeVisible()
    await expect(window.getByRole('option', { name: 'Workspace', exact: true })).toHaveCount(0)
    await window.keyboard.press('Escape')

    await switchVertical(window, 'Workspace')
    await window.setViewportSize({ width: 720, height: 800 })
    await window.getByRole('button', { name: 'Toggle workspace navigation', exact: true }).click()
    await expect(window.getByRole('dialog', { name: 'Sidebar', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Open Project', exact: true })).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(workspace).toBeVisible()
    await window.setViewportSize({ width: 1280, height: 900 })
    await window.reload()
    await expect(window.getByRole('main', { name: 'Agent workspace' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Switch application, Workspace' })).toBeVisible()
    await window.screenshot({ path: test.info().outputPath('workspace-vertical.png'), fullPage: true })
  })
})
