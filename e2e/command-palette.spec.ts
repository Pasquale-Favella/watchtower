import { test, expect } from '@playwright/test'
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
    await dismissOnboarding(window)

    await window.keyboard.press('ControlOrMeta+k')
    const input = window.getByPlaceholder('Go to a section or run an action...')
    await expect(input).toBeVisible()

    await input.fill('Models')
    const row = window.getByRole('option', { name: 'Models' })
    await expect(row).toBeVisible()
    await input.press('Enter')

    // The dialog closes and the Models view renders its (always-mounted)
    // lens tabs.
    await expect(window.getByRole('dialog')).toBeHidden()
    await expect(window.getByRole('tab', { name: 'By model' })).toBeVisible({ timeout: 30_000 })
  })
})
