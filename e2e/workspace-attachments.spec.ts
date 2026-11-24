import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'
import { pdfFixture } from './fixtures/attachments'

function removeProfile(directory: string): void {
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}watchtower-attachments-`))
    throw new Error('Unexpected profile path')
  rmSync(directory, { recursive: true, force: true })
}

test('image and PDF chips preview, remove, persist and render in sent messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-attachments-'))
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    const log = join(directory, 'agent.jsonl')
    const script = resolve('e2e/fixtures/attachment-agent.mjs')
    const shim = join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini')
    writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" "${log}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath}' '${script}' '${log}' "$@"\n`,
    )
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    launched = await launchApp(directory, undefined, bin)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
    await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await window.getByRole('option', { name: /^Default/ }).click()
    await window.keyboard.press('Escape')
    const png = {
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
        'base64',
      ),
    }
    const pdf = { name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdfFixture() }
    const prompt = window.getByRole('textbox', { name: 'Prompt', exact: true })
    const fileInput = window.locator('input[type=file]')
    await fileInput.setInputFiles([png, pdf])
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(2)
    await expect(newChat.getByRole('list', { name: 'Attachments', exact: true })).toHaveCount(0)
    await prompt.getByRole('button', { name: /^File attachment, notes.pdf,/ }).click()
    const pdfDialog = window.getByRole('dialog', { name: 'notes.pdf', exact: true })
    await expect(pdfDialog.getByRole('searchbox', { name: 'Find in PDF' })).toBeVisible()
    await expect
      .poll(() => pdfDialog.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width))
      .toBeGreaterThan(0)
    await expect(pdfDialog.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
    await expect(pdfDialog.locator('.textLayer')).toContainText('First page')
    await pdfDialog.getByRole('button', { name: 'Next page', exact: true }).click()
    await expect(pdfDialog.getByRole('spinbutton', { name: 'PDF page' })).toHaveValue('2')
    await expect(pdfDialog.locator('.textLayer')).toContainText('Second page')
    await pdfDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await prompt.getByRole('button', { name: /^Image attachment, pixel.png,/ }).click()
    const imageDialog = window.getByRole('dialog', { name: 'pixel.png', exact: true })
    await expect(imageDialog.getByRole('img', { name: 'pixel.png', exact: true })).toBeVisible()
    await imageDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await prompt.getByRole('button', { name: 'Remove pixel.png', exact: true }).click()
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(1)
    await expect(prompt).not.toContainText('pixel.png')
    expect(
      await window.evaluate(() => localStorage.getItem('watchtower.workspace.prompt-attachments.v1')),
    ).not.toContain('pixel.png')
    await prompt.fill('')
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(0)
    expect(
      await window.evaluate(() => localStorage.getItem('watchtower.workspace.prompt-attachments.v1')),
    ).not.toContain('notes.pdf')
    await prompt.evaluate((input, encoded) => {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File([Uint8Array.from(atob(encoded), character => character.charCodeAt(0))], 'notes.pdf', {
          type: 'application/pdf',
        }),
      )
      clipboardData.setData('text/plain', 'notes.pdf')
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, pdf.buffer.toString('base64'))
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(1)
    await expect(prompt.getByRole('button', { name: /^File attachment, notes.pdf,/ })).toBeVisible()
    await prompt.fill('Review these attachments')
    await fileInput.setInputFiles([png, pdf])
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(2)
    await window.reload()
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(2)
    await prompt.press('Control+End')
    await prompt.press('Backspace')
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(2)
    await prompt.press('Enter')
    const sent = window.getByRole('article', { name: 'User message', exact: true })
    const mixed = sent.filter({ hasText: 'Review these attachments' })
    await expect(mixed.getByRole('img', { name: 'pixel.png', exact: true })).toBeVisible()
    await mixed.getByRole('button', { name: /^File attachment, notes.pdf,/ }).click()
    await expect(pdfDialog.getByRole('searchbox', { name: 'Find in PDF' })).toBeVisible()
    await pdfDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await mixed.getByRole('button', { name: 'Preview pixel.png', exact: true }).click()
    await expect(imageDialog.getByRole('img', { name: 'pixel.png', exact: true })).toBeVisible()
    await imageDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(window.getByText('Attachments received.', { exact: true })).toBeVisible()
    const received = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0] ?? '{}') as {
      images: number
      text: string
    }
    expect(received.images).toBe(1)
    expect(received.text).toContain('notes.pdf')
    await fileInput.setInputFiles(pdf)
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(1)
    await prompt.press('Enter')
    await expect(sent).toHaveCount(2)
    await expect(sent.last().getByRole('list', { name: 'Attached files' })).toBeVisible()
    await expect(sent.last().locator('.typeset')).toHaveCount(0)
    await fileInput.setInputFiles([png, { ...png, name: 'second.png' }])
    await expect(prompt.locator('[data-prompt-file-chip]')).toHaveCount(2)
    await prompt.press('Enter')
    await expect(sent).toHaveCount(3)
    await expect(sent.last().getByRole('img', { name: /pixel.png|second.png/ })).toHaveCount(2)
    await expect(sent.last().locator('.typeset')).toHaveCount(0)
    await sent.last().getByRole('button', { name: 'Preview pixel.png', exact: true }).click()
    await expect(imageDialog).toBeVisible()
    await imageDialog.getByRole('button', { name: 'Next image', exact: true }).click()
    const secondImage = window.getByRole('dialog', { name: 'second.png', exact: true })
    await expect(secondImage.getByRole('img', { name: 'second.png', exact: true })).toBeVisible()
    await secondImage.press('ArrowLeft')
    await expect(imageDialog).toBeVisible()
    await imageDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await window.reload()
    await mixed.getByRole('button', { name: /^File attachment, notes.pdf,/ }).click()
    await expect(pdfDialog.getByRole('searchbox', { name: 'Find in PDF' })).toBeVisible()
    await expect(pdfDialog.locator('.textLayer')).toContainText('First page')
    await window.screenshot({ path: test.info().outputPath('attachment-pdf.png'), fullPage: true })
    await pdfDialog.getByRole('button', { name: 'Close', exact: true }).click()
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeProfile(directory)
  }
})
