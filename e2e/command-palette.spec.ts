import { expect, test } from '@playwright/test'

import { dismissOnboarding, withApp } from './app'

/**
 * Command palette v1 (ADR 0028, tracks #133): Mod+K opens the launcher over
 * Sections + Actions, typing filters the rows, and Enter runs the
 * highlighted row — here navigating to the Models section. Declarative
 * checks live in `tests/command-palette.test.ts`; this spec proves the real
 * window wiring (hotkey → dialog → navigation).
 */
test('palette opens, filters, and navigates to Models', async () => {
  await withApp(async ({ window }) => {
    await test.step('dismiss first-run onboarding', () => dismissOnboarding(window))

    const input = window.getByPlaceholder('Go to a section or run an action...')
    await test.step('open command palette', async () => {
      await window.keyboard.press('ControlOrMeta+k')
      await expect(input).toBeVisible()
    })

    const row = window.getByRole('option', { name: 'Models' })
    await test.step('filter for Models', async () => {
      await input.fill('Models')
      await expect(row).toBeVisible()
    })

    // The dialog closes and the Models view renders its (always-mounted)
    // lens tabs.
    await test.step('navigate to Models', async () => {
      await input.press('Enter')
      await expect(window.getByRole('dialog')).toBeHidden()
      await expect(window.getByRole('tab', { name: 'By model' })).toBeVisible({ timeout: 30_000 })
    })
  })
})
