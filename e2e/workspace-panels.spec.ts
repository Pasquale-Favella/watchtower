import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'
import { invokeRpc, invokeRpcStreamFirst } from './rpc-probe'

function removeTestDirectory(directory: string): void {
  const absolute = resolve(directory)
  const expectedPrefix = `${resolve(tmpdir())}${sep}watchtower-panels-`
  if (!absolute.startsWith(expectedPrefix)) throw new Error('Unexpected test profile')
  rmSync(absolute, { recursive: true, force: true })
}

test('draft terminals and browser tabs preserve their resources across hiding, tab changes and reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-panels-'))
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
      request.url === '/next'
        ? '<!doctype html><title>Second fixture page</title><h1>Next page</h1>'
        : '<!doctype html><title>Workspace browser fixture</title><h1>Local preview</h1><a href="/next">Next</a>',
    )
  })
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
    const url = `http://127.0.0.1:${address.port}/`
    launched = await launchApp(directory)
    const { window, app, pageErrors } = launched
    await dismissOnboarding(window)
    const header = window.locator('header[aria-label="Chat header"]')
    const newChat = window.getByRole('region', { name: 'New chat', exact: true })
    await expect(newChat.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('No project')
    await header.getByRole('button', { name: 'Terminal', exact: true }).click()
    const drawer = window.locator('[data-terminal-owner="drawer"]')
    await expect(drawer).toBeVisible()
    const input = drawer.locator('.xterm-helper-textarea').first()
    await expect(input).toBeVisible()
    await input.pressSequentially('echo WT_DRAFT_PANEL_OUTPUT')
    await input.press('Enter')
    const target = await window.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('watchtower.workspace.draft-panel-contexts.v1') ?? '{}') as Record<
        string,
        string
      >
      return { kind: 'draft' as const, draftId: saved.scratch, projectId: null }
    })
    await expect
      .poll(async () => {
        const result = await invokeRpcStreamFirst(window, 'terminal:attach', { target, terminalId: 'term-1' })
        return result.ok ? ((result.value as { data?: string }).data ?? '') : ''
      })
      .toContain('WT_DRAFT_PANEL_OUTPUT')
    await header.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(drawer).toBeHidden()
    await expect(await invokeRpc(window, 'terminal:list', { target })).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ terminalId: 'term-1', status: 'running' })] },
    })
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Browser', exact: true }).click()
    const browser = panel.getByRole('region', { name: 'Browser preview', exact: true })
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).fill(url)
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).press('Enter')
    const pageTitle = () =>
      app.evaluate(
        ({ webContents }, expectedUrl) =>
          webContents
            .getAllWebContents()
            .find(contents => contents.getURL() === expectedUrl)
            ?.getTitle(),
        url,
      )
    await expect.poll(pageTitle).toBe('Workspace browser fixture')
    await app.evaluate(
      ({ webContents }, expectedUrl) =>
        webContents
          .getAllWebContents()
          .find(contents => contents.getURL() === expectedUrl)
          ?.executeJavaScript('document.querySelector("a").click()', true),
      url,
    )
    await expect(browser.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(`${url}next`)
    await browser.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(browser.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(url)
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).fill('javascript:alert(1)')
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).press('Enter')
    const addressError = browser.getByRole('alert').filter({ hasText: 'Enter an HTTP or HTTPS address.' })
    await expect(addressError).toBeVisible()
    const errorBounds = await addressError.boundingBox()
    if (!errorBounds) throw new Error('Browser validation message unavailable')
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, expectedUrl) => {
          const view = BrowserWindow.getAllWindows()
            .flatMap(window => window.contentView.children)
            .find(
              candidate =>
                'webContents' in candidate &&
                (candidate as import('electron').WebContentsView).webContents.getURL() === expectedUrl,
            )
          return view?.getBounds().y ?? 0
        }, url),
      )
      .toBeGreaterThanOrEqual(errorBounds.y + errorBounds.height - 1)
    await expect.poll(pageTitle).toBe('Workspace browser fixture')
    await browser.getByRole('button', { name: 'Dismiss browser error', exact: true }).click()
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).fill(url)
    await browser.getByRole('textbox', { name: 'Browser address', exact: true }).press('Enter')
    await browser.getByRole('button', { name: 'Annotate page', exact: true }).click()
    const annotation = window.getByRole('dialog', { name: 'Annotate screenshot', exact: true })
    await expect(annotation.getByRole('img', { name: 'Screenshot to annotate', exact: true })).toBeVisible()
    await annotation
      .getByRole('textbox', { name: 'Screenshot instructions', exact: true })
      .fill('Review the local preview')
    await annotation.getByRole('button', { name: 'Add to chat', exact: true }).click()
    await expect(annotation).toBeHidden()
    await expect(newChat.locator('[data-prompt-annotation]')).toHaveCount(1)
    await newChat
      .getByRole('button', { name: 'Page annotation Review the local preview. Show details', exact: true })
      .click()
    await expect(window.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(newChat.getByRole('textbox', { name: 'Prompt', exact: true })).toContainText(
      'Review the local preview',
    )
    await panel.getByRole('button', { name: 'Maximize panel', exact: true }).click()
    await expect(newChat).toBeHidden()
    await expect(header).toBeVisible()
    await panel.getByRole('button', { name: 'Restore panel size', exact: true }).click()
    await expect(newChat).toBeVisible()
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect.poll(pageTitle).toBe('Workspace browser fixture')
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
    await expect(panel.locator('[data-terminal-owner="panel"]')).toBeVisible()
    await expect
      .poll(() => invokeRpc(window, 'terminal:list', { target }))
      .toMatchObject({
        ok: true,
        value: {
          items: expect.arrayContaining([
            expect.objectContaining({ terminalId: 'term-1' }),
            expect.objectContaining({ terminalId: 'term-2' }),
          ]),
        },
      })
    await panel.getByRole('tab', { name: 'Workspace browser fixture', exact: true }).click()
    await expect(browser.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(url)
    await window.screenshot({ path: test.info().outputPath('workspace-panels.png'), fullPage: true })
    await window.reload()
    await expect(window.getByRole('complementary', { name: 'Right panel', exact: true })).toBeVisible()
    await expect(window.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(url)
    await expect(newChat.locator('[data-prompt-annotation]')).toHaveCount(1)
    await newChat
      .getByRole('button', { name: 'Page annotation Review the local preview. Show details', exact: true })
      .click()
    await expect(window.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
    await window.keyboard.press('Escape')
    const copied = await newChat.locator('[data-composer-attachment]').evaluate(node => {
      const record = JSON.parse(node.getAttribute('data-prompt-attachment') ?? '{}') as { id: string }
      return { html: node.outerHTML, text: `[Review the local preview](attachment:${record.id}) ` }
    })
    await newChat.getByRole('button', { name: 'Remove page annotation Review the local preview', exact: true }).click()
    await expect(newChat.locator('[data-prompt-annotation]')).toHaveCount(0)
    const savedAttachments = await window.evaluate(() =>
      localStorage.getItem('watchtower.workspace.prompt-attachments.v1'),
    )
    expect(savedAttachments).not.toContain('Review the local preview')
    await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).evaluate((input, content) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', content.text)
      clipboardData.setData('text/html', content.html)
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, copied)
    await expect(newChat.locator('[data-prompt-annotation]')).toHaveCount(1)
    await newChat
      .getByRole('button', { name: 'Page annotation Review the local preview. Show details', exact: true })
      .click()
    await expect(window.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
    await window.keyboard.press('Escape')
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    await new Promise<void>((resolveClosed, reject) => server.close(error => (error ? reject(error) : resolveClosed())))
    removeTestDirectory(directory)
  }
})
