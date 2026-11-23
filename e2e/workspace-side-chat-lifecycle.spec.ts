import { expect, test } from '@playwright/test'

import { invokeRpc } from './rpc-probe'
import { openSideChatFromPanel, withSideChatWorkspace } from './side-chat-fixture'

test('a side chat takes its title from its first message in the tab, the header, and the side chats list', async () => {
  await withSideChatWorkspace(async window => {
    const { header, panel, side } = await openSideChatFromPanel(window)
    await expect(panel.getByRole('tab', { name: 'Side chat', exact: true })).toBeVisible()
    await expect(side.locator('header')).toContainText('Side chat')
    const sidePrompt = side.getByRole('textbox', { name: 'Prompt', exact: true })
    const sideRequests = side.getByRole('region', { name: 'Approvals and questions', exact: true })
    await sidePrompt.fill('Trace the parser flow\nwith the details')
    await sidePrompt.press('Enter')
    await expect(side.locator('header').getByText('Trace the parser flow', { exact: true })).toBeVisible()
    await expect(panel.getByRole('tab', { name: 'Trace the parser flow, needs approval', exact: true })).toBeVisible()
    await sideRequests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    await expect(side.getByRole('button', { name: 'Delete side chat', exact: true })).toBeEnabled()
    await sidePrompt.fill('A later question that must not retitle the side chat')
    await sidePrompt.press('Enter')
    await sideRequests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    await expect(side.getByRole('button', { name: 'Delete side chat', exact: true })).toBeEnabled()
    await expect(panel.getByRole('tab', { name: 'Trace the parser flow', exact: true })).toBeVisible()
    await expect(side.locator('header').getByText('Trace the parser flow', { exact: true })).toBeVisible()
    const detailsTrigger = header.getByRole('button', { name: 'Conversation details', exact: true })
    await detailsTrigger.click()
    const details = window.getByRole('dialog', { name: 'Conversation details', exact: true })
    await expect(
      details
        .getByRole('region', { name: 'Side chats', exact: true })
        .getByRole('button', { name: 'Trace the parser flow', exact: true }),
    ).toBeVisible()
  })
})

test('closing a side chat that never ran removes it from the side chats list', async () => {
  await withSideChatWorkspace(async window => {
    const { header, side } = await openSideChatFromPanel(window)
    await side.getByRole('button', { name: 'Close side chat', exact: true }).click()
    await expect(side).toBeHidden()
    const detailsTrigger = header.getByRole('button', { name: 'Conversation details', exact: true })
    if ((await detailsTrigger.getAttribute('aria-pressed')) !== 'true') await detailsTrigger.click()
    await expect(window.locator('#conversation-details-panel')).toBeVisible()
    await expect(window.getByRole('region', { name: 'Side chats', exact: true })).toHaveCount(0)
  })
})

test('deleting a side chat asks first: cancel keeps it, and confirming removes it and closes its tab', async () => {
  await withSideChatWorkspace(async window => {
    const { header, panel, side } = await openSideChatFromPanel(window)
    const title = 'Keep this side chat until confirmed'
    const sidePrompt = side.getByRole('textbox', { name: 'Prompt', exact: true })
    await sidePrompt.fill(title)
    await sidePrompt.press('Enter')
    await side
      .getByRole('region', { name: 'Approvals and questions', exact: true })
      .getByRole('button', { name: 'Skip inspection', exact: true })
      .click()
    const deleteButton = side.getByRole('button', { name: 'Delete side chat', exact: true })
    await expect(deleteButton).toBeEnabled()
    await deleteButton.click()
    const dialog = window.getByRole('alertdialog', { name: `Delete side chat "${title}"?`, exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(side).toBeVisible()
    await expect(panel.getByRole('tab', { name: title, exact: true })).toBeVisible()
    await deleteButton.click()
    await window
      .getByRole('alertdialog', { name: `Delete side chat "${title}"?`, exact: true })
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect(side).toHaveCount(0)
    await expect(panel.getByRole('tab', { name: title, exact: true })).toHaveCount(0)
    const detailsTrigger = header.getByRole('button', { name: 'Conversation details', exact: true })
    if ((await detailsTrigger.getAttribute('aria-pressed')) !== 'true') await detailsTrigger.click()
    await expect(window.locator('#conversation-details-panel')).toBeVisible()
    await expect(window.getByRole('region', { name: 'Side chats', exact: true })).toHaveCount(0)
  })
})

test('a side chat deleted while its tab is open shows the deleted state', async () => {
  await withSideChatWorkspace(async window => {
    const { side } = await openSideChatFromPanel(window)
    const taskId = await side.getAttribute('data-side-chat-pane')
    expect(taskId).toMatch(/^side-task:/)
    const id = `side-chat:${taskId?.slice('side-task:'.length)}`
    await expect(invokeRpc(window, 'sideChat:delete', { id })).resolves.toMatchObject({
      ok: true,
      value: { deleted: true },
    })
    await expect(window.getByRole('status').filter({ hasText: 'This side chat was deleted.' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(side).toHaveCount(0)
  })
})
