import { readFileSync } from 'node:fs'

import { expect, type Locator, test } from '@playwright/test'

import { dismissOnboarding, launchApp, type LaunchedApp } from './app'
import { addProjectAndSelectAgent, createSideChatFixture, removeSideChatFixture } from './side-chat-fixture'

async function expectPromptValue(prompt: Locator, expected: string | RegExp): Promise<void> {
  const value = () =>
    prompt.evaluate(element =>
      Array.from(element.children)
        .map(paragraph => paragraph.textContent ?? '')
        .join('\n'),
    )
  if (typeof expected === 'string') await expect.poll(value).toBe(expected)
  else await expect.poll(value).toMatch(expected)
}

test('side chats use the parent snapshot, share its checkout, and bring replies back to the next main run', async () => {
  const fixture = createSideChatFixture()
  const { repository, harness, protocolLog } = fixture
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(fixture.directory, undefined, harness)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    await addProjectAndSelectAgent(window, repository)
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Parent snapshot marker')
    await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).press('Enter')
    const main = window.getByRole('region', { name: 'Main conversation', exact: true })
    const parentComposer = main.getByRole('region', { name: 'Conversation composer', exact: true })
    const parentPrompt = parentComposer.getByRole('textbox', { name: 'Prompt', exact: true })
    const parentRequests = main.getByRole('region', { name: 'Approvals and questions', exact: true })
    await expect(parentRequests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await parentPrompt.fill('Keep the parent draft')
    const header = window.locator('header[aria-label="Chat header"]')
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await panel.getByRole('button', { name: 'Side chat', exact: true }).click()
    const side = panel.getByRole('region', { name: 'Side chat', exact: true })
    await expect(side).toBeVisible()
    await expectPromptValue(parentPrompt, 'Keep the parent draft')
    // A side chat shares the main chat's checkout, so its pane offers no checkout strip or branch control.
    await expect(side.getByRole('button', { name: /^Checkout:/ })).toHaveCount(0)
    await expect(side.getByRole('combobox', { name: 'Branch', exact: true })).toHaveCount(0)
    const sidePrompt = side.getByRole('textbox', { name: 'Prompt', exact: true })
    await sidePrompt.fill('Ask independently in the side chat')
    await expect(side.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await sidePrompt.press('Enter')
    const sideRequests = side.getByRole('region', { name: 'Approvals and questions', exact: true })
    await expect(sideRequests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    // The tab reports the approval the side chat waits for, and the main chat announces it.
    await expect(
      panel.getByRole('tab', { name: 'Ask independently in the side chat, needs approval', exact: true }),
    ).toBeVisible()
    await expect(window.getByRole('status').filter({ hasText: 'Side chat waiting' })).toBeVisible()
    const detailsTrigger = header.getByRole('button', { name: 'Conversation details', exact: true })
    await detailsTrigger.click()
    const details = window.getByRole('dialog', { name: 'Conversation details', exact: true })
    const sideChats = details.getByRole('region', { name: 'Side chats', exact: true })
    const sideChatRow = sideChats.getByRole('button', { name: 'Ask independently in the side chat', exact: true })
    await expect(sideChatRow).toBeVisible()
    await expect(sideChatRow.getByRole('status')).toHaveText('Waiting')
    await detailsTrigger.click()
    const sideMessage = side.getByRole('article', { name: 'User message', exact: true })
    await expect(sideMessage).toContainText('Ask independently in the side chat')
    await expect(sideMessage).not.toContainText('Parent conversation snapshot')
    // The main chat is still awaiting its approval, so the side chat's reply cannot be brought back yet.
    const bringBack = side.getByRole('button', { name: 'Bring back', exact: true })
    await expect(bringBack).toHaveAttribute('aria-disabled', 'true')
    await parentRequests.getByRole('button', { name: 'Inspect once', exact: true }).click()
    await expect(
      main
        .getByRole('region', { name: 'Messages', exact: true })
        .getByText('Checkout inspection finished.', { exact: true }),
    ).toBeVisible()
    await sideRequests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    await expect(bringBack).toHaveAttribute('aria-disabled', 'false')
    await bringBack.click()
    await expect(
      side.getByText('Brought back. The main chat gets this side chat with your next message.'),
    ).toBeVisible()
    // Bring back is a pending transfer, so the main draft is left as it was.
    await expectPromptValue(parentPrompt, 'Keep the parent draft')
    await side.getByRole('button', { name: 'Close side chat', exact: true }).click()
    await expect(side).toBeHidden()
    // A side chat that already ran is kept, and reopens from the details panel.
    // Closing the last panel tab hides the panel, so the details open inline rather than as a dialog.
    if ((await detailsTrigger.getAttribute('aria-pressed')) !== 'true') await detailsTrigger.click()
    await window
      .getByRole('region', { name: 'Side chats', exact: true })
      .getByRole('button', { name: 'Ask independently in the side chat', exact: true })
      .click()
    await expect(side).toBeVisible()
    await expectPromptValue(sidePrompt, '')
    // Reopening a side chat opens the panel with its tab, so the panel is already open here.
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    // The add menu lists only "Side chat"; earlier side chats are reopened from details.
    await expect(window.getByRole('menuitem', { name: 'Side chat', exact: true })).toHaveCount(1)
    await window.keyboard.press('Escape')
    // The delivered reply reaches the next main Run with the original request.
    await parentPrompt.fill('Keep the parent draft')
    await parentPrompt.press('Enter')
    await parentRequests.getByRole('button', { name: 'Inspect once', exact: true }).click()
    await expect(
      main
        .getByRole('region', { name: 'Messages', exact: true })
        .getByText('Checkout inspection finished.', { exact: true })
        .nth(1),
    ).toBeVisible()
    const prompts = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as { kind: string; sessionId?: string; prompt?: Array<{ type: string; text?: string }> },
      )
      .filter(record => record.kind === 'prompt')
    expect(prompts).toHaveLength(3)
    expect(prompts[0]?.sessionId).not.toBe(prompts[1]?.sessionId)
    const promptText = (index: number) =>
      prompts[index]?.prompt
        ?.filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n') ?? ''
    const sideText = promptText(1)
    expect(sideText).toContain('Ask independently in the side chat')
    expect(sideText).toContain('Parent snapshot marker')
    const mainText = promptText(2)
    expect(mainText).toContain('was brought back')
    expect(mainText).toContain('Checkout inspection finished.')
    expect(mainText).toContain('Current request: Keep the parent draft')
    await expect(window.getByRole('button', { name: 'Side chat', exact: true })).toHaveCount(0)
    expect(pageErrors).toEqual([])
    await window.screenshot({ path: test.info().outputPath('workspace-side-chat.png'), fullPage: true })
  } finally {
    await launched?.close()
    removeSideChatFixture(fixture.directory)
  }
})
