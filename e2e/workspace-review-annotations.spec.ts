import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, type Locator, type Page, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-review-`))
    throw new Error('Unexpected review fixture path')
  rmSync(absolute, { recursive: true, force: true })
}

async function annotateRange(page: Page, surface: Locator, start: number, end: number, text: string): Promise<void> {
  const first = surface.locator(`[data-column-number="${start}"]`).first()
  const last = surface.locator(`[data-column-number="${end}"]`).first()
  await expect(first).toBeVisible()
  await expect(last).toBeVisible()
  const firstBox = await first.boundingBox()
  const lastBox = await last.boundingBox()
  if (!firstBox || !lastBox) throw new Error('Code gutter is unavailable')
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 8 })
  await page.mouse.up()
  const comment = surface.getByRole('textbox', { name: /^Comment on lines/ })
  await expect(comment).toBeVisible()
  await comment.fill(text)
  await comment.press('ControlOrMeta+Enter')
  await expect(surface.getByText(text, { exact: true })).toBeVisible()
}

test('native file editing saves to disk and review annotations survive navigation and reach the agent once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-review-'))
  const repository = join(directory, 'repository')
  const harness = join(directory, 'bin')
  const protocolLog = join(directory, 'protocol.jsonl')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    mkdirSync(harness)
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    writeFileSync(join(repository, 'README.md'), '# Review fixture\n')
    writeFileSync(join(repository, 'other file.ts'), 'export const reference = true\n')
    mkdirSync(join(repository, '.agents', 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(repository, '.agents', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review the fixture\n---\nReview this change carefully.\n',
    )
    writeFileSync(
      join(repository, 'example.ts'),
      'export const first = 1\nexport const second = 2\nexport const third = 3\n',
    )
    execFileSync('git', ['add', '.'], { cwd: repository, windowsHide: true, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Review test',
        '-c',
        'user.email=review@example.invalid',
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
    await window
      .locator('header[aria-label="Chat header"]')
      .getByRole('button', { name: 'Right panel', exact: true })
      .click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await panel.getByRole('button', { name: 'Files', exact: true }).click()
    await panel.getByRole('tabpanel').locator('[data-item-path="example.ts"]').click()
    const active = panel.getByRole('tabpanel')
    const surface = active.locator('[data-review-code-surface="example.ts"]')
    const editor = surface.locator('[contenteditable="true"]')
    await expect(editor).toBeVisible()
    await editor.click()
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await editor.pressSequentially('// saved by native editor')
    await expect.poll(() => readFileSync(join(repository, 'example.ts'), 'utf8')).toContain('// saved by native editor')
    await editor.press('ControlOrMeta+s')
    await expect(active.getByRole('status', { name: 'File saved', exact: true })).toBeVisible()
    await window.screenshot({ path: test.info().outputPath('native-file-editor.png') })
    await annotateRange(window, surface, 1, 2, 'Keep these exports consistent')
    const comments = newChat.getByRole('list', { name: 'Review comments', exact: true })
    await expect(comments).toContainText('example.ts:L1 to L2')
    await active.getByRole('button', { name: 'Hide file tree', exact: true }).click()
    await window.screenshot({ path: test.info().outputPath('file-review-annotation.png') })
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    await panel.getByRole('tab', { name: 'example.ts', exact: true }).click()
    await expect(surface.getByText('Keep these exports consistent', { exact: true })).toBeVisible()
    await surface.getByRole('button', { name: 'Delete comment', exact: true }).click()
    await expect(comments).toBeHidden()
    await annotateRange(window, surface, 2, 3, 'Review the second and third exports')
    await expect(comments).toContainText('example.ts:L2 to L3')
    await expect(newChat.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveText('')
    await expect(newChat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await newChat.getByRole('button', { name: 'Send', exact: true }).click()
    const main = window.getByRole('region', { name: 'Main conversation', exact: true })
    const message = main.getByRole('article', { name: 'User message', exact: true })
    await expect(message).toContainText('Review the second and third exports')
    await expect(message).toContainText('export const second = 2')
    await expect(message).toContainText('export const third = 3')
    await expect
      .poll(() => (existsSync(protocolLog) ? readFileSync(protocolLog, 'utf8') : ''))
      .toContain('Review the second and third exports')
    const protocol = readFileSync(protocolLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; prompt?: unknown })
    const prompts = protocol.filter(frame => frame.kind === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0].prompt).match(/Review the second and third exports/g)).toHaveLength(1)
    await expect(main.getByRole('list', { name: 'Review comments', exact: true })).toBeHidden()
    await main
      .getByRole('region', { name: 'Approvals and questions', exact: true })
      .getByRole('button', { name: 'Skip inspection', exact: true })
      .click()
    await expect(main).toContainText('Checkout inspection finished.')
    const prompt = main.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('/fixture')
    await window.getByRole('option').filter({ hasText: 'fixture-check' }).first().click()
    await expect(prompt.getByRole('button', { name: 'Command fixture-check. Show details', exact: true })).toBeVisible()
    await prompt.press('ControlOrMeta+End')
    await prompt.pressSequentially('$review')
    await window.getByRole('option').filter({ hasText: 'review' }).first().click()
    await expect(prompt.getByRole('button', { name: 'Skill review. Show details', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    await panel.getByRole('tabpanel').locator('[data-item-path="other file.ts"]').click()
    await panel.getByRole('tabpanel').getByRole('button', { name: 'File actions', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Add to chat', exact: true }).click()
    await expect(prompt.locator('[aria-label="File reference other file.ts"]')).toBeVisible()
    await main.getByRole('button', { name: 'Send', exact: true }).click()
    const references = main.getByRole('article', { name: 'User message', exact: true }).last()
    await expect(
      references.getByRole('button', { name: 'Command fixture-check. Show details', exact: true }),
    ).toBeVisible()
    await expect(references.getByRole('button', { name: 'Skill review. Show details', exact: true })).toBeVisible()
    await expect(references.locator('[aria-label="File reference other file.ts"]')).toBeVisible()
    await main
      .getByRole('region', { name: 'Approvals and questions', exact: true })
      .getByRole('button', { name: 'Skip inspection', exact: true })
      .click()
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeTestDirectory(directory)
  }
})
