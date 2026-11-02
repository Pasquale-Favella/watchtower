import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'
import { invokeRpc } from './rpc-probe'

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
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    await launched.app.evaluate(({ dialog }, repository) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] })
    }, repository)
    await window.getByRole('button', { name: 'Browse for project folder', exact: true }).click()
    await expect(window.getByLabel('Local checkout path', { exact: true })).toHaveValue(repository)
    await window.getByLabel('Project name', { exact: true }).fill('Controls fixture')
    await window.getByLabel('Local checkout path', { exact: true }).fill(repository)
    await window
      .getByRole('dialog', { name: 'Open a Project' })
      .getByRole('button', { name: 'Open Project', exact: true })
      .click()
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    await expect(newChat).toBeVisible()
    const newPrompt = newChat.getByRole('textbox', { name: 'Prompt', exact: true })
    await newPrompt.fill('Inspect this checkout')
    await expect(newChat.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('Controls fixture')
    await newChat.getByRole('button', { name: 'or start without a project', exact: true }).click()
    await expect(newPrompt).toHaveValue('Inspect this checkout')
    await newChat.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('combobox', { name: 'Search Projects', exact: true }).fill('Controls')
    await window.getByRole('option', { name: 'Controls fixture', exact: true }).click()
    await expect(newPrompt).toHaveValue('Inspect this checkout')
    await newChat.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'No project', exact: true }).click()
    await expect(newChat.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('No project')
    await newChat.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Controls fixture', exact: true }).click()
    await window.screenshot({ path: test.info().outputPath('workspace-new-chat.png'), fullPage: true })
    await newChat.getByLabel('Harness connection').selectOption({ label: 'Gemini CLI' })
    await expect(newChat.getByText('Ready to send', { exact: true })).toBeVisible()
    await newPrompt.fill('Inspect this checkout')
    await newPrompt.press('Shift+Enter')
    await expect(newPrompt).toHaveValue('Inspect this checkout\n')
    await newPrompt.press('Enter')
    const composer = window.getByRole('region', { name: 'Conversation composer' })
    await expect(composer).toBeVisible()
    const prompt = composer.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveValue('')
    const requests = window.getByRole('region', { name: 'Approvals and questions' })
    await expect(requests.getByText('Inspect checkout status', { exact: true }).first()).toBeVisible()
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await expect(requests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    await prompt.fill('Queued work to cancel')
    await prompt.press('Enter')
    const queue = composer.getByRole('list', { name: 'Queued prompts' })
    await expect(queue.getByText('Queued work to cancel', { exact: true })).toBeVisible()
    await queue.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(queue).toHaveCount(0)
    await prompt.fill('Queued work to dispatch')
    await prompt.press('Enter')
    await expect(queue.getByText('Queued work to dispatch', { exact: true })).toBeVisible()
    await prompt.fill('Keep this draft during navigation')
    await window.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(newPrompt).toHaveValue('')
    await newPrompt.fill('Independent second draft')
    await window.getByRole('button', { name: /Inspect this checkout/ }).click()
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await window.reload()
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await expect(queue.getByText('Queued work to dispatch', { exact: true })).toBeVisible()
    await requests.getByRole('button', { name: 'Inspect once', exact: true }).click()
    await expect(
      window
        .getByRole('region', { name: 'Messages', exact: true })
        .getByText('Checkout inspection finished.', { exact: true }),
    ).toBeVisible()
    await expect(queue.getByRole('button', { name: 'Dispatch', exact: true })).toBeEnabled()
    await queue.getByRole('button', { name: 'Dispatch', exact: true }).click()
    await expect(requests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await composer.getByRole('button', { name: 'Inspect Run connection to enable Stop', exact: true }).click()
    await composer.getByRole('button', { name: 'Stop Run', exact: true }).click()
    await expect(composer.getByRole('button', { name: 'Stop Run', exact: true })).toHaveCount(0)
    await expect(prompt).toHaveValue('Keep this draft during navigation')
    await window.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(newPrompt).toHaveValue('Independent second draft')
    await expect(newChat.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('No project')
    await newChat.getByLabel('Harness connection').selectOption({ label: 'Gemini CLI' })
    await expect(newChat.getByText('Ready to send', { exact: true })).toBeVisible()
    await newPrompt.fill('Discuss without a project')
    await newPrompt.press('Enter')
    await expect(window.getByRole('heading', { name: 'Discuss without a project', exact: true })).toBeVisible()
    await expect(requests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    await requests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    expect(await invokeRpc(window, 'workspace:listProjects', {})).toMatchObject({
      ok: true,
      value: { items: expect.arrayContaining([expect.objectContaining({ name: 'No project', isScratch: true })]) },
    })
    await window.reload()
    await expect(window.getByRole('heading', { name: 'Discuss without a project', exact: true })).toBeVisible()
    await window.setViewportSize({ width: 720, height: 800 })
    await expect(prompt).toBeInViewport()
    await window.screenshot({ path: test.info().outputPath('workspace-controls.png'), fullPage: true })
    const records = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; result?: unknown })
    expect(records.filter(record => record.kind === 'prompt')).toHaveLength(3)
    expect(records.filter(record => record.kind === 'decision')).toContainEqual({
      kind: 'decision',
      result: { outcome: { outcome: 'selected', optionId: 'fixture-read-once' } },
    })
    expect(records.filter(record => record.kind === 'cancel')).toHaveLength(1)
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
