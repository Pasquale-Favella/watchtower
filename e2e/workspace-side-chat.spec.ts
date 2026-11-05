import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  const expectedPrefix = `${resolve(tmpdir())}${sep}watchtower-side-chat-`
  if (!absolute.startsWith(expectedPrefix)) throw new Error('Unexpected side chat test directory')
  rmSync(absolute, { recursive: true, force: true })
}

test('side chats use the parent snapshot, run independently and bring replies back to its draft', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-side-chat-'))
  const repository = join(directory, 'repository')
  const harness = join(directory, 'bin')
  const protocolLog = join(directory, 'protocol.jsonl')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    mkdirSync(harness)
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    writeFileSync(join(repository, 'README.md'), 'Side chat fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repository, windowsHide: true, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Side chat test',
        '-c',
        'user.email=side@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Initial fixture',
      ],
      { cwd: repository, windowsHide: true, stdio: 'pipe' },
    )
    const script = resolve('e2e/fixtures/workspace-agent.mjs')
    const shim = join(harness, process.platform === 'win32' ? 'gemini.cmd' : 'gemini')
    writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" "${protocolLog}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${protocolLog.replaceAll("'", "'\\''")}' "$@"\n`,
    )
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    launched = await launchApp(directory, undefined, harness)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Add project', exact: true })
    await dialog.getByRole('option', { name: /^Local folder/ }).click()
    await dialog.getByRole('combobox', { name: 'Project folder', exact: true }).fill(repository)
    await dialog.getByRole('button', { name: /^Add \(/ }).click()
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
    await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await window.getByRole('option', { name: /^Default/ }).click()
    await window.keyboard.press('Escape')
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
    await expect(parentPrompt).toHaveValue('Keep the parent draft')
    await side.getByRole('button', { name: 'Checkout: Current checkout', exact: true }).click()
    await window.getByRole('menuitemradio', { name: /^New worktree/ }).click()
    await window.keyboard.press('Escape')
    await expect(side.getByRole('combobox', { name: 'Branch', exact: true })).toBeEnabled()
    const sidePrompt = side.getByRole('textbox', { name: 'Prompt', exact: true })
    await sidePrompt.fill('Ask independently in the side chat')
    await expect(side.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await sidePrompt.press('Enter')
    const sideRequests = side.getByRole('region', { name: 'Approvals and questions', exact: true })
    await expect(sideRequests.getByRole('button', { name: 'Skip inspection', exact: true })).toBeEnabled()
    const sideMessage = side.getByRole('article', { name: 'User message', exact: true })
    await expect(sideMessage).toContainText('Ask independently in the side chat')
    await expect(sideMessage).not.toContainText('Parent conversation snapshot')
    await expect(parentRequests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await sideRequests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
    await expect(side.getByRole('button', { name: 'Bring back', exact: true })).toBeEnabled()
    await side.getByRole('button', { name: 'Bring back', exact: true }).click()
    await expect(parentPrompt).toHaveValue(/Keep the parent draft[\s\S]*Checkout inspection finished\./)
    await expect(parentRequests.getByRole('button', { name: 'Inspect once', exact: true })).toBeEnabled()
    await side.getByRole('button', { name: 'Close side chat', exact: true }).click()
    await expect(side).toBeHidden()
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await expect(window.getByRole('menuitem', { name: 'Side chat', exact: true })).toHaveCount(2)
    await window.getByRole('menuitem', { name: 'Side chat', exact: true }).last().click()
    await expect(side).toBeVisible()
    await expect(sidePrompt).toHaveValue('')
    await parentRequests.getByRole('button', { name: 'Inspect once', exact: true }).click()
    await expect(
      main
        .getByRole('region', { name: 'Messages', exact: true })
        .getByText('Checkout inspection finished.', { exact: true }),
    ).toBeVisible()
    const prompts = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as { kind: string; sessionId?: string; prompt?: Array<{ type: string; text?: string }> },
      )
      .filter(record => record.kind === 'prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.sessionId).not.toBe(prompts[1]?.sessionId)
    const sideText =
      prompts[1]?.prompt
        ?.filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n') ?? ''
    expect(sideText).toContain('Ask independently in the side chat')
    expect(sideText).toContain('Parent snapshot marker')
    expect(pageErrors).toEqual([])
    await window.screenshot({ path: test.info().outputPath('workspace-side-chat.png'), fullPage: true })
  } finally {
    await launched?.close()
    removeTestDirectory(directory)
  }
})
