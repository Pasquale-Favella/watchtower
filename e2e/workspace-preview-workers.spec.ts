import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'
import JSZip from 'jszip'

import { dismissOnboarding, launchApp } from './app'

function removeFixture(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-preview-workers-`))
    throw new Error('Unexpected fixture path')
  rmSync(absolute, { recursive: true, force: true })
}

test('document workers load previews while the workspace remains interactive', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-preview-workers-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    mkdirSync(repository)
    execFileSync('git', ['init', repository], { stdio: 'pipe', windowsHide: true })
    writeFileSync(join(repository, 'source.ts'), 'export const visible = true\n')
    writeFileSync(
      join(repository, 'report.ipynb'),
      JSON.stringify({
        cells: [
          { cell_type: 'markdown', source: '# Notebook result' },
          { cell_type: 'code', source: 'print(42)', outputs: [{ output_type: 'stream', text: '42' }] },
        ],
      }),
    )
    const archive = new JSZip().file('nested/readme.txt', 'Archive contents')
    writeFileSync(join(repository, 'bundle.zip'), await archive.generateAsync({ type: 'nodebuffer' }))
    const word = new JSZip().file(
      'word/document.xml',
      '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Document fixture</w:t></w:r></w:p></w:body></w:document>',
    )
    writeFileSync(join(repository, 'document.docx'), await word.generateAsync({ type: 'nodebuffer' }))
    execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'pipe', windowsHide: true })
    launched = await launchApp(directory)
    const { window, pageErrors } = launched
    await dismissOnboarding(window)
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Add project', exact: true })
    await dialog.getByRole('option', { name: /^Local folder/ }).click()
    await dialog.getByRole('combobox', { name: 'Project folder', exact: true }).fill(repository)
    await dialog.getByRole('button', { name: /^Add \(/ }).click()
    await window
      .locator('header[aria-label="Chat header"]')
      .getByRole('button', { name: 'Right panel', exact: true })
      .click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await panel.getByRole('button', { name: 'Files', exact: true }).click()
    await panel.getByRole('tabpanel').locator('button[data-item-path="report.ipynb"]').click()
    await expect(
      panel.getByRole('tabpanel').getByRole('heading', { name: 'Notebook result', exact: true }),
    ).toBeVisible()
    await expect(panel.getByRole('tabpanel').getByText('print(42)', { exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    await panel.getByRole('tabpanel').locator('button[data-item-path="bundle.zip"]').click()
    await panel
      .getByRole('tabpanel')
      .getByRole('button', { name: /nested\/readme.txt/ })
      .click()
    await expect(panel.getByRole('tabpanel').getByText('Archive contents', { exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    await panel.getByRole('tabpanel').locator('button[data-item-path="document.docx"]').click()
    const documentFrame = panel.getByRole('tabpanel').frameLocator('iframe')
    await expect(documentFrame.getByText('Document fixture', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Close right panel', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect(window.getByRole('region', { name: 'New chat', exact: true })).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeFixture(directory)
  }
})
