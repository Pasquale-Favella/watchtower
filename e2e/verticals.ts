import { expect, type Page } from '@playwright/test'

export async function switchVertical(window: Page, vertical: 'Analytics' | 'Workspace'): Promise<void> {
  await window.getByRole('button', { name: /^Switch application,/ }).click()
  await window.getByRole('menuitem', { name: new RegExp(`^${vertical}`) }).click()
  await expect(window.getByRole('button', { name: `Switch application, ${vertical}` })).toBeVisible()
}
