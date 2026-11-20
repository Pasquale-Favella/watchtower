import { expect, test } from '@playwright/test'

import { dismissOnboarding, withApp } from './app'

test('conversation details remember inline visibility and keep popovers transient', async () => {
  await withApp(async ({ window }) => {
    await dismissOnboarding(window)
    await window.setViewportSize({ width: 1900, height: 900 })

    const header = window.locator('header[aria-label="Chat header"]')
    const toggle = header.getByRole('button', { name: 'Conversation details', exact: true })
    const details = window.locator('[data-conversation-details-panel]')
    const prompt = window.getByRole('textbox', { name: 'Prompt', exact: true })

    // Wide inline details open by default and remain alongside the right panel.
    await expect(details).toHaveAttribute('data-conversation-details-panel', 'inline')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.hover()
    await expect(window.getByRole('tooltip', { name: 'Conversation details', exact: true })).toHaveAttribute(
      'data-side',
      'left',
    )
    await details.getByRole('button', { name: 'Customize conversation details', exact: true }).click()
    const branchItem = window.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Branch', exact: true })
    await expect(window.getByRole('menuitemcheckbox', { name: 'Agent runs', exact: true })).toHaveCount(0)
    await expect(branchItem).toHaveAttribute('aria-checked', 'true')
    await branchItem.click()
    await expect(branchItem).toHaveAttribute('aria-checked', 'false')
    await window.keyboard.press('Escape')
    await expect(details.getByRole('combobox', { name: 'Branch', exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: 'Right panel', exact: true }).click()
    const rightPanel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await expect(rightPanel).toBeVisible()
    await expect(details).toHaveAttribute('data-conversation-details-panel', 'inline')
    const panelBounds = await rightPanel.boundingBox()
    const detailsBounds = await details.boundingBox()
    if (!panelBounds || !detailsBounds) throw new Error('Panel or details card has no visible bounds')
    expect(detailsBounds.x + detailsBounds.width).toBeLessThanOrEqual(panelBounds.x)

    // At 1600px the open right panel leaves too little room for inline details.
    // Changing to popover mode closes the details card instead of carrying its
    // open state into a mode where it would cover the conversation.
    await window.setViewportSize({ width: 1600, height: 900 })
    await expect(details).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(rightPanel).toBeVisible()
    await window.screenshot({ path: test.info().outputPath('conversation-details-narrow.png') })

    await toggle.click()
    const dialog = window.getByRole('dialog', { name: 'Conversation details', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-conversation-details-panel', 'popover')
    await window.screenshot({ path: test.info().outputPath('conversation-details-popover.png') })

    // Resizing away from popover mode clears its transient open state.
    await window.setViewportSize({ width: 1900, height: 900 })
    await expect(details).toHaveAttribute('data-conversation-details-panel', 'inline')
    await expect(dialog).toHaveCount(0)
    await window.setViewportSize({ width: 1600, height: 900 })
    await expect(details).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await toggle.click()
    await expect(dialog).toBeVisible()
    await window.locator('header[aria-label="Chat header"] h1').click()
    await expect(dialog).toHaveCount(0)

    await toggle.click()
    await expect(dialog).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // Draft text stays in the composer while the transient popover opens/closes.
    await prompt.fill('Keep this draft while inspecting details')
    await toggle.click()
    await expect(dialog).toBeVisible()
    await prompt.click()
    await expect(dialog).toHaveCount(0)
    await expect(prompt).toHaveText('Keep this draft while inspecting details')

    // Returning to a wide layout restores the remembered inline preference.
    await window.setViewportSize({ width: 1900, height: 900 })
    await expect(details).toHaveAttribute('data-conversation-details-panel', 'inline')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(details).toHaveCount(0)
    await window.reload()
    await window.setViewportSize({ width: 1900, height: 900 })
    await expect(window.locator('[data-conversation-details-panel]')).toHaveCount(0)
    await expect(
      window.locator('header[aria-label="Chat header"]').getByRole('button', {
        name: 'Conversation details',
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(details).toHaveAttribute('data-conversation-details-panel', 'inline')
    await details.getByRole('button', { name: 'Customize conversation details', exact: true }).click()
    await expect(
      window.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Branch', exact: true }),
    ).toHaveAttribute('aria-checked', 'false')
    await window.keyboard.press('Escape')
    await details.click({ button: 'right' })
    const contextMenu = window.getByRole('menu')
    await expect(contextMenu.getByRole('menuitemcheckbox', { name: 'Branch', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await window.keyboard.press('Escape')
    await details.getByRole('button', { name: 'Close conversation details', exact: true }).click()
    await expect(details).toHaveCount(0)
  })
})
