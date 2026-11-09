import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

test('scratch chat keeps native model, effort, mode, and permission choices exact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-model-options-'))
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

    launched = await launchApp(directory, undefined, harnessDirectory)
    const { window } = launched
    await dismissOnboarding(window)

    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    const project = newChat.getByRole('combobox', { name: 'Project', exact: true })
    const prompt = newChat.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(newChat).toBeVisible()
    await expect(project).toHaveText('No project')
    await expect(prompt).toBeEditable()
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toHaveCount(0)
    await expect(window.locator('[data-terminal-owner="drawer"]')).toHaveCount(0)

    await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
    const picker = window.getByRole('dialog', { name: 'Choose agent and model', exact: true })
    await expect(picker).toBeVisible()
    await picker
      .getByRole('group', { name: 'Agents', exact: true })
      .getByRole('button', { name: 'Gemini CLI', exact: true })
      .click()
    await picker.getByRole('option', { name: 'Fixture model', exact: true }).click()

    await picker
      .getByRole('radiogroup', { name: 'Effort', exact: true })
      .getByRole('radio', { name: 'High', exact: true })
      .click()

    const agentOption = picker.getByRole('button', { name: 'Agent: General', exact: true })
    await agentOption.press('ArrowRight')
    const agentMenu = window.getByRole('menu')
    await expect(agentMenu.getByRole('menuitemradio', { name: 'Reviewer', exact: true })).toBeVisible()
    await window.keyboard.press('ArrowLeft')
    await expect(agentMenu).toHaveCount(0)
    await expect(agentOption).toBeFocused()
    await agentOption.press('ArrowRight')
    await window.getByRole('menuitemradio', { name: 'Reviewer', exact: true }).click()

    await picker.getByRole('button', { name: 'Mode: Code', exact: true }).click()
    await window.getByRole('menuitemradio', { name: 'Plan', exact: true }).click()
    await window.screenshot({ path: test.info().outputPath('workspace-model-options.png'), fullPage: true })
    await window.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)

    await prompt.fill('Check this scratch workspace')
    await prompt.press('Enter')

    const requests = window.getByRole('region', { name: 'Approvals and questions', exact: true })
    await expect(requests.getByText('Inspect checkout status', { exact: true }).first()).toBeVisible()
    await expect(requests.getByText('git status --short', { exact: true })).toBeVisible()
    await expect(requests.getByText('fixture-checkout', { exact: true })).toBeVisible()
    await expect(requests.getByRole('button', { name: 'More options', exact: true })).toBeEnabled()
    await requests.getByRole('button', { name: 'More options', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Always inspect', exact: true }).click()
    await expect(window.getByText('Checkout inspection finished.', { exact: true })).toBeVisible()

    const records = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; params?: Record<string, unknown>; result?: unknown })
    const configUpdates = records
      .filter(record => record.kind === 'session/set_config_option')
      .map(record => ({ configId: record.params?.configId, value: record.params?.value }))
      .sort((left, right) => String(left.configId).localeCompare(String(right.configId)))
    expect(configUpdates).toEqual([
      { configId: 'agent', value: 'reviewer' },
      { configId: 'effort', value: 'high' },
    ])
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'session/set_mode',
          params: expect.objectContaining({ modeId: 'plan' }),
        }),
        expect.objectContaining({
          kind: 'session/set_model',
          params: expect.objectContaining({ modelId: 'fixture-model' }),
        }),
        expect.objectContaining({
          kind: 'decision',
          result: { outcome: { outcome: 'selected', optionId: 'fixture-read-always' } },
        }),
      ]),
    )
    expect(launched.pageErrors).toEqual([])
    await launched.close()
    launched = undefined
  } finally {
    if (launched?.pageErrors.length) {
      await test.info().attach('renderer-errors', {
        body: launched.pageErrors.map(error => error.stack ?? error.message).join('\n'),
        contentType: 'text/plain',
      })
    }
    await launched?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
