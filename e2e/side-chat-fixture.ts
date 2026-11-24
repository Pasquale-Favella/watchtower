import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, type Page } from '@playwright/test'

import { dismissOnboarding, launchApp, type LaunchedApp } from './app'

const DIRECTORY_PREFIX = 'watchtower-side-chat-'

export interface SideChatFixture {
  readonly directory: string
  readonly repository: string
  readonly harness: string
  readonly protocolLog: string
}

/** A temporary Git repository and a Gemini CLI shim that runs the workspace agent fixture. */
export function createSideChatFixture(): SideChatFixture {
  const directory = mkdtempSync(join(tmpdir(), DIRECTORY_PREFIX))
  const repository = join(directory, 'repository')
  const harness = join(directory, 'bin')
  const protocolLog = join(directory, 'protocol.jsonl')
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
  } catch (error) {
    removeSideChatFixture(directory)
    throw error
  }
  return { directory, repository, harness, protocolLog }
}

/** Removes only a directory this fixture created. The fixture holds no junctions, so a recursive delete is safe. */
export function removeSideChatFixture(directory: string): void {
  const absolute = resolve(directory)
  const expectedPrefix = `${resolve(tmpdir())}${sep}${DIRECTORY_PREFIX}`
  if (!absolute.startsWith(expectedPrefix)) throw new Error('Unexpected side chat test directory')
  rmSync(absolute, { recursive: true, force: true })
}

/** Adds the fixture repository as a project and selects the Gemini CLI agent for the new chat. */
export async function addProjectAndSelectAgent(window: Page, repository: string): Promise<void> {
  await window.getByRole('combobox', { name: 'Project', exact: true }).click()
  await window.getByRole('option', { name: /^Add project/ }).click()
  const dialog = window.getByRole('dialog', { name: 'Add project', exact: true })
  await dialog.getByRole('option', { name: /^Local folder/ }).click()
  await dialog.getByRole('combobox', { name: 'Project folder', exact: true }).fill(repository)
  await dialog.getByRole('button', { name: /^Add \(/ }).click()
  const newChat = window.getByRole('region', { name: 'New chat', exact: true })
  await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
  await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
  await window.getByRole('option', { name: /^Default/ }).click()
  await window.keyboard.press('Escape')
}

/** Sends the first main message and skips its inspection approval, so the main chat is idle with a reply. */
export async function startMainConversation(window: Page, repository: string, prompt: string): Promise<void> {
  await dismissOnboarding(window)
  await addProjectAndSelectAgent(window, repository)
  const newChat = window.getByRole('region', { name: 'New chat', exact: true })
  await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt)
  await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).press('Enter')
  const main = window.getByRole('region', { name: 'Main conversation', exact: true })
  const requests = main.getByRole('region', { name: 'Approvals and questions', exact: true })
  await requests.getByRole('button', { name: 'Skip inspection', exact: true }).click()
  await expect(
    main
      .getByRole('region', { name: 'Messages', exact: true })
      .getByText('Checkout inspection finished.', { exact: true }),
  ).toBeVisible()
}

/** Launches the app on a fresh fixture, starts a main conversation, and removes the fixture afterwards. */
export async function withSideChatWorkspace(body: (window: Page) => Promise<void>): Promise<void> {
  const fixture = createSideChatFixture()
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(fixture.directory, undefined, fixture.harness)
    await startMainConversation(launched.window, fixture.repository, 'Parent snapshot marker')
    await body(launched.window)
    expect(launched.pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeSideChatFixture(fixture.directory)
  }
}

/** Opens the right panel from the main chat header and returns its Side chat region after creating a side chat. */
export async function openSideChatFromPanel(window: Page) {
  const header = window.locator('header[aria-label="Chat header"]')
  await header.getByRole('button', { name: 'Right panel', exact: true }).click()
  const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
  await panel.getByRole('button', { name: 'Side chat', exact: true }).click()
  const side = panel.getByRole('region', { name: 'Side chat', exact: true })
  await expect(side).toBeVisible()
  return { header, panel, side }
}
