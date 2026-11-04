import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'
import { invokeRpc, invokeRpcStreamFirst } from './rpc-probe'

function observeSubmissionUi(): void {
  new MutationObserver(() => {
    if (document.body?.textContent?.includes('Unconfirmed message')) {
      sessionStorage.setItem('unconfirmed-message-seen', 'true')
    }
  }).observe(document, { subtree: true, childList: true, characterData: true })
}

test('composer drives an isolated protocol peer, restores drafts and approval state, and controls queued work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-controls-'))
  const repository = join(directory, 'repository')
  const harnessDirectory = join(directory, 'bin')
  const protocolLog = join(directory, 'protocol.jsonl')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    mkdirSync(harnessDirectory)
    const script = resolve('e2e/fixtures/workspace-agent.mjs')
    const shim = join(harnessDirectory, process.platform === 'win32' ? 'gemini.cmd' : 'gemini')
    writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" "${protocolLog}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${protocolLog.replaceAll("'", "'\\''")}' "$@"\n`,
    )
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    execFileSync('git', ['init', repository], { stdio: 'pipe', windowsHide: true })
    writeFileSync(join(repository, 'README.md'), 'Fixture repository\n')
    mkdirSync(join(repository, '.agents', 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(repository, '.agents', 'skills', 'review', 'SKILL.md'),
      'Check the tests before suggesting a fix.',
    )
    writeFileSync(join(repository, 'notes.txt'), 'Original attached notes')
    execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'pipe', windowsHide: true })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Workspace Test',
        '-c',
        'user.email=workspace@example.invalid',
        'commit',
        '-m',
        'Initial fixture',
      ],
      { cwd: repository, stdio: 'pipe', windowsHide: true },
    )
    launched = await launchApp(directory, undefined, harnessDirectory)
    const { window } = launched
    await dismissOnboarding(window)
    await window.addInitScript(observeSubmissionUi)
    await window.evaluate(observeSubmissionUi)
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    const addProject = window.getByRole('dialog', { name: 'Add project' })
    await addProject.getByRole('option', { name: /^Local folder/ }).click()
    const folder = addProject.getByRole('combobox', { name: 'Project folder', exact: true })
    await expect(folder).toHaveValue('~/')
    await folder.fill(`${directory}${process.platform === 'win32' ? '\\' : '/'}rep`)
    await expect(addProject.getByRole('option', { name: 'repository', exact: true })).toBeVisible()
    await folder.press('Tab')
    await expect(folder).toHaveValue(new RegExp(`repository[\\\\/]$`))
    await expect(addProject.getByRole('option', { name: '..', exact: true })).toBeVisible()
    await folder.press('Enter')
    const header = window.locator('header[aria-label="Chat header"]')
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    const projectPicker = newChat.getByRole('combobox', { name: 'Project', exact: true })
    await expect(newChat).toBeVisible()
    await expect(header).toHaveCount(1)
    await expect(header.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Terminal', exact: true })).toBeEnabled()
    await header.getByRole('button', { name: 'Terminal', exact: true }).click()
    const draftTerminal = window.locator('[data-terminal-owner="drawer"]')
    await expect(draftTerminal).toBeVisible()
    const terminalInput = draftTerminal.locator('.xterm-helper-textarea').first()
    await terminalInput.pressSequentially('echo WT_TERMINAL_ADOPTION')
    await terminalInput.press('Enter')
    const draftTarget = await window.evaluate(() => {
      const contexts = JSON.parse(
        localStorage.getItem('watchtower.workspace.draft-panel-contexts.v1') ?? '{}',
      ) as Record<string, string>
      const projectId = Object.keys(contexts).find(key => key !== 'scratch')
      if (!projectId) throw new Error('Project draft was not retained')
      return { kind: 'draft' as const, projectId, draftId: contexts[projectId] }
    })
    await expect
      .poll(async () => {
        const result = await invokeRpcStreamFirst(window, 'terminal:attach', {
          target: draftTarget,
          terminalId: 'term-1',
        })
        return result.ok ? ((result.value as { data?: string }).data ?? '') : ''
      })
      .toContain('WT_TERMINAL_ADOPTION')
    await header.getByRole('button', { name: 'Terminal', exact: true }).click()
    await header.getByRole('button', { name: 'Agent run details', exact: true }).click()
    const runDetails = window.getByRole('dialog', { name: 'Agent run details', exact: true })
    await expect(runDetails.getByText('Send a message to start an agent run.', { exact: true })).toBeVisible()
    await runDetails.getByRole('button', { name: 'Close', exact: true }).click()
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await expect(window.getByRole('complementary', { name: 'Right panel', exact: true })).toBeVisible()
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    const newPrompt = newChat.getByRole('textbox', { name: 'Prompt', exact: true })
    await newPrompt.fill('Inspect this checkout')
    await expect(projectPicker).toHaveText('repository')
    await projectPicker.click()
    await window.getByRole('option', { name: 'No project', exact: true }).click()
    await expect(newPrompt).toHaveValue('Inspect this checkout')
    await projectPicker.click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    await launched.app.evaluate(({ dialog }, repository) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] })
    }, repository)
    await addProject.getByRole('button', { name: /^Open in / }).click()
    await expect(addProject).toHaveCount(0)
    await expect(projectPicker).toHaveText('repository')
    await expect(newPrompt).toHaveValue('Inspect this checkout')
    await projectPicker.click()
    await window.getByRole('option', { name: 'No project', exact: true }).click()
    await expect(projectPicker).toHaveText('No project')
    await projectPicker.click()
    await window.getByRole('combobox', { name: 'Search Projects', exact: true }).fill('repo')
    await window.getByRole('option', { name: 'repository', exact: true }).click()
    await window.screenshot({ path: test.info().outputPath('workspace-new-chat.png'), fullPage: true })
    await newPrompt.fill('/mod')
    await expect(newChat.getByRole('option', { name: '/model command', exact: true })).toBeVisible()
    await newPrompt.press('Enter')
    await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await window.getByRole('option', { name: /^Default/ }).click()
    await window.keyboard.press('Escape')
    await expect(newChat.getByRole('button', { name: 'Agent and model', exact: true })).toContainText('Default model')
    await expect(newChat.getByRole('combobox', { name: 'Branch', exact: true })).toHaveText(/main|master/)
    await expect(newChat.getByRole('button', { name: 'Checkout: Current checkout', exact: true })).toBeVisible()
    await newPrompt.fill('Inspect this checkout @READ')
    await expect(newChat.getByRole('option', { name: 'README.md', exact: true })).toBeVisible()
    await newPrompt.press('Enter')
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toContainText('README.md')
    await newPrompt.fill('/rev')
    await expect(newChat.getByRole('option', { name: '/review skill', exact: true })).toBeVisible()
    await newPrompt.press('Tab')
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toContainText('SKILL.md')
    await newChat.locator('input[type=file]').setInputFiles({
      name: 'context.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Attachment from the file picker'),
    })
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toContainText('context.txt')
    await newPrompt.evaluate(input => {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File(
          [
            Uint8Array.from(
              atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='),
              value => value.charCodeAt(0),
            ),
          ],
          'pixel.png',
          { type: 'image/png' },
        ),
      )
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    })
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toContainText('pixel.png')
    await newChat.getByRole('button', { name: 'pixel.png', exact: true }).click()
    await expect(window.getByRole('dialog', { name: 'pixel.png', exact: true })).toBeVisible()
    await window
      .getByRole('dialog', { name: 'pixel.png', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await newPrompt.fill('Inspect this checkout')
    await newPrompt.press('Shift+Enter')
    await expect(newPrompt).toHaveValue('Inspect this checkout\n')
    await newPrompt.press('Enter')
    const composer = window.getByRole('region', { name: 'Conversation composer' })
    const composerLane = composer.locator('.max-w-chat')
    await expect(composer).toBeVisible()
    const createdTasks = await invokeRpc(window, 'workspace:listTasks', { projectId: draftTarget.projectId })
    if (!createdTasks.ok) throw new Error('Created chat unavailable')
    const startedTaskId = (createdTasks.value as { items: Array<{ id: string; title: string }> }).items.find(
      task => task.title === 'Inspect this checkout',
    )?.id
    if (!startedTaskId) throw new Error('Created chat unavailable')
    await expect(await invokeRpc(window, 'terminal:list', { taskId: startedTaskId })).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ terminalId: 'term-1', status: 'running' })] },
    })
    const adoptedTerminal = await invokeRpcStreamFirst(window, 'terminal:attach', {
      taskId: startedTaskId,
      terminalId: 'term-1',
    })
    expect(adoptedTerminal).toMatchObject({
      ok: true,
      value: { data: expect.stringContaining('WT_TERMINAL_ADOPTION') },
    })
    await expect(header).toHaveCount(1)
    await expect(header).toContainText('repository')
    await expect(header.getByRole('heading', { name: 'Inspect this checkout', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Terminal', exact: true })).toBeEnabled()
    await header.getByRole('button', { name: 'Agent run details', exact: true }).click()
    await expect(runDetails.getByText('Submitted', { exact: true })).toBeVisible()
    await runDetails.getByRole('button', { name: 'Close', exact: true }).click()
    const prompt = composer.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect
      .poll(() =>
        composerLane.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          const parent = element.parentElement?.getBoundingClientRect()
          return {
            width: bounds.width,
            maxWidth: getComputedStyle(element).maxWidth,
            centered: parent ? Math.abs(bounds.left + bounds.width / 2 - (parent.left + parent.width / 2)) < 2 : false,
          }
        }),
      )
      .toMatchObject({ maxWidth: '736px', centered: true })
    await expect(prompt).toHaveValue('')
    const requests = window.getByRole('region', { name: 'Approvals and questions' })
    await expect(requests.getByText('Inspect checkout status', { exact: true }).first()).toBeVisible()
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await expect(requests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    await prompt.fill('/fixture-')
    await expect(composer.getByRole('option', { name: '/fixture-check agent command', exact: true })).toBeVisible()
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('/fixture-check ')
    await prompt.fill('Queued work to cancel')
    await prompt.press('Enter')
    const queue = composer.getByRole('list', { name: 'Queued prompts' })
    await expect(queue.getByText('Queued work to cancel', { exact: true })).toBeVisible()
    await queue.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(queue).toHaveCount(0)
    await composer.getByRole('button', { name: 'Agent and model', exact: true }).click()
    await window.getByRole('option', { name: 'Fixture model', exact: true }).click()
    await window
      .getByRole('radiogroup', { name: /^(Effort|Mode)$/ })
      .getByRole('radio', { name: /plan/i })
      .click()
    await expect(composer.getByRole('combobox', { name: 'Branch', exact: true })).toBeVisible()
    await composer.locator('input[type=file]').setInputFiles(join(repository, 'notes.txt'))
    await expect(composer.getByRole('list', { name: 'Attachments', exact: true })).toContainText('notes.txt')
    await prompt.fill('Queued work to dispatch')
    await prompt.press('Enter')
    await expect(queue.getByText('Queued work to dispatch', { exact: true })).toBeVisible()
    writeFileSync(join(repository, 'notes.txt'), 'Changed after queueing')
    await prompt.fill('Keep this draft during navigation')
    await prompt.evaluate(input => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['Draft context'], 'draft-context.txt', { type: 'text/plain' }))
      input.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
    })
    await expect(composer.getByRole('list', { name: 'Attachments', exact: true })).toContainText('draft-context.txt')
    await window.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(newPrompt).toHaveValue('')
    await newPrompt.fill('Independent second draft')
    await window.getByRole('button', { name: /Inspect this checkout/ }).click()
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await window.reload()
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await expect(composer.getByRole('list', { name: 'Attachments', exact: true })).toContainText('draft-context.txt')
    await composer.getByRole('button', { name: 'Remove draft-context.txt', exact: true }).click()
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await expect(queue.getByText('Queued work to dispatch', { exact: true })).toBeVisible()
    await requests.getByRole('button', { name: 'Inspect once', exact: true }).click()
    await expect(
      window
        .getByRole('region', { name: 'Messages', exact: true })
        .getByText('Checkout inspection finished.', { exact: true }),
    ).toBeVisible()
    await expect(queue).toHaveCount(0)
    const messages = window.getByRole('region', { name: 'Messages', exact: true })
    await expect(messages.getByText('Queued work to dispatch', { exact: true })).toBeVisible()
    await expect(messages.getByText('(empty response)', { exact: true })).toHaveCount(0)
    await window.screenshot({ path: test.info().outputPath('workspace-chat-desktop.png'), fullPage: true })
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await composer.getByRole('button', { name: 'Stop Run', exact: true }).click()
    await expect(composer.getByRole('button', { name: 'Stop Run', exact: true })).toHaveCount(0)
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await window.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(newPrompt).toHaveValue('Independent second draft')
    await expect(projectPicker).toHaveText('No project')
    await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
    await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await window.getByRole('option', { name: /^Default/ }).click()
    await window.keyboard.press('Escape')
    await expect(newChat.getByRole('button', { name: 'Agent and model', exact: true })).toContainText('Default model')
    await expect(newChat.getByRole('button', { name: 'Permissions: Supervised', exact: true })).toBeVisible()
    await newPrompt.fill('Discuss without a project')
    await newPrompt.press('Enter')
    await expect(window.getByRole('heading', { name: 'Discuss without a project', exact: true })).toBeVisible()
    await expect(requests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    await requests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    await expect(composer.getByRole('button', { name: 'Stop Run', exact: true })).toHaveCount(0)
    await prompt.fill('Continue this conversation')
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('')
    await expect(requests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    await requests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    expect(await window.evaluate(() => sessionStorage.getItem('unconfirmed-message-seen'))).toBeNull()
    expect(await invokeRpc(window, 'workspace:listProjects', {})).toMatchObject({
      ok: true,
      value: { items: expect.arrayContaining([expect.objectContaining({ name: 'No project', isScratch: true })]) },
    })
    await window.reload()
    await expect(window.getByRole('heading', { name: 'Discuss without a project', exact: true })).toBeVisible()
    await window.setViewportSize({ width: 720, height: 800 })
    await expect(prompt).toBeInViewport()
    const latestInspectionMessage = messages.getByText('Checkout inspection finished.', { exact: true }).last()
    await expect(latestInspectionMessage).toBeVisible()
    await expect(latestInspectionMessage).toBeInViewport()
    await expect(messages.getByText('(empty response)', { exact: true })).toHaveCount(0)
    await window.evaluate(
      () =>
        new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    const messageInsideTimeline = await latestInspectionMessage.evaluate(element => {
      const row = element.closest('[data-message-id]')
      const region = element.closest('[aria-label="Messages"]')
      if (!row || !region) return false
      const rowBounds = row.getBoundingClientRect()
      const regionBounds = region.getBoundingClientRect()
      return rowBounds.bottom > regionBounds.top && rowBounds.top < regionBounds.bottom
    })
    expect(messageInsideTimeline).toBe(true)
    await expect
      .poll(() =>
        composerLane.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          const parent = element.parentElement?.getBoundingClientRect()
          return {
            width: bounds.width,
            parentWidth: parent?.width ?? 0,
            centered: parent ? Math.abs(bounds.left + bounds.width / 2 - (parent.left + parent.width / 2)) < 2 : false,
          }
        }),
      )
      .toMatchObject({ centered: true })
    const narrowLane = await composerLane.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    }))
    expect(narrowLane.width).toBeLessThanOrEqual(narrowLane.parentWidth)
    const latestUserMessage = messages.getByRole('article', { name: 'User message', exact: true }).filter({
      has: window.getByText('Continue this conversation', { exact: true }),
    })
    await expect(latestUserMessage).toBeInViewport()
    const userMessageBounds = await latestUserMessage.boundingBox()
    const userTextBounds = await latestUserMessage.locator('.watchtower-markdown').boundingBox()
    if (!userMessageBounds || !userTextBounds) throw new Error('User message geometry unavailable')
    expect(userMessageBounds.height).toBeLessThanOrEqual(userTextBounds.height + 20)
    await latestUserMessage.hover()
    const copyMessage = latestUserMessage.getByRole('button', { name: 'Copy message', exact: true })
    await expect(copyMessage.locator('..')).toHaveCSS('opacity', '1')
    await prompt.hover()
    await copyMessage.focus()
    await expect(copyMessage).toBeFocused()
    await expect(copyMessage.locator('..')).toHaveCSS('opacity', '1')
    expect((await latestUserMessage.boundingBox())?.height).toBe(userMessageBounds.height)
    await prompt.focus()
    await expect(copyMessage.locator('..')).toHaveCSS('opacity', '0')
    await window.screenshot({ path: test.info().outputPath('workspace-controls.png'), fullPage: true })
    const records = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {
            kind: string
            result?: unknown
            prompt?: Array<{ type: string; text?: string; data?: string }>
            sessionId?: string
          },
      )
    const sentPrompts = records.filter(record => record.kind === 'prompt')
    expect(sentPrompts).toHaveLength(4)
    expect(sentPrompts[1].sessionId).toBe(sentPrompts[0].sessionId)
    expect(sentPrompts[3].sessionId).toBe(sentPrompts[2].sessionId)
    expect(sentPrompts[0].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: expect.any(String) }),
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Fixture repository') }),
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Check the tests before suggesting a fix.'),
        }),
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Attachment from the file picker') }),
      ]),
    )
    expect(sentPrompts[1].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Original attached notes') }),
      ]),
    )
    expect(JSON.stringify(sentPrompts[1])).not.toContain('Changed after queueing')
    expect(records.filter(record => record.kind === 'decision')).toContainEqual({
      kind: 'decision',
      result: { outcome: { outcome: 'selected', optionId: 'fixture-read-once' } },
    })
    expect(records.filter(record => record.kind === 'cancel')).toHaveLength(1)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'session/set_mode', params: expect.objectContaining({ modeId: 'plan' }) }),
        expect.objectContaining({
          kind: 'session/set_model',
          params: expect.objectContaining({ modelId: 'fixture-model' }),
        }),
      ]),
    )
    expect(launched.pageErrors).toEqual([])
    await launched.close()
    launched = undefined
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
