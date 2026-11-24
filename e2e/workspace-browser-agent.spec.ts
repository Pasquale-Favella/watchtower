import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { type ElectronApplication, expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeProfile(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-browser-agent-`))
    throw new Error('Unexpected profile directory')
  rmSync(absolute, { recursive: true, force: true })
}

async function pickInPreview(app: ElectronApplication, url: string, selector: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, target) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === target.url)
      if (!contents) throw new Error('The Workspace browser WebContents was not found.')
      const rect = (await contents.executeJavaScript(
        `(() => { const {x,y,width,height} = document.querySelector(${JSON.stringify(target.selector)}).getBoundingClientRect(); return {x:x + width / 2,y:y + height / 2} })()`,
      )) as { x: number; y: number }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type,
          x: rect.x,
          y: rect.y,
          ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
        })
    },
    { url, selector },
  )
}

for (const transport of ['http', 'stdio'] as const) {
  test(`an Agent Run controls the visible Workspace browser through scoped MCP over ${transport}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-browser-agent-'))
    const bin = join(directory, 'bin')
    const log = join(directory, 'browser.jsonl')
    mkdirSync(bin)
    const script = resolve('e2e/fixtures/browser-agent.mjs')
    const shim = join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini')
    writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" ${transport === 'stdio' ? '--stdio ' : ''}"${log}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' ${transport === 'stdio' ? '--stdio ' : ''}'${log.replaceAll("'", "'\\''")}' "$@"\n`,
    )
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        '<!doctype html><title>Agent browser fixture</title><label>Name<input id="name"></label><button id="greet" onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Greet</button><p id="result"></p>',
      )
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    let launched: Awaited<ReturnType<typeof launchApp>> | undefined
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture server')
      const url = `http://127.0.0.1:${address.port}/`
      launched = await launchApp(directory, undefined, bin)
      const { window, app, pageErrors } = launched
      await dismissOnboarding(window)
      const newChat = window.getByRole('region', { name: 'New chat', exact: true })
      await newChat.getByRole('button', { name: 'Agent and model', exact: true }).click()
      await window.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
      await window.getByRole('option', { name: /^Default/ }).click()
      await window.keyboard.press('Escape')
      await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).fill(`Inspect ${url}`)
      await newChat.getByRole('textbox', { name: 'Prompt', exact: true }).press('Enter')
      const entries = (): Array<Record<string, unknown>> =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(line => JSON.parse(line))
          : []
      await expect
        .poll(
          () =>
            entries().find(entry => entry.kind === 'browser-complete') ??
            entries().find(entry => entry.kind === 'browser-error'),
          { timeout: 60_000 },
        )
        .toMatchObject({
          kind: 'browser-complete',
          screenshot: true,
          snapshot: {
            visibleText: expect.stringContaining('Hello Browser agent'),
            viewport: { width: 390, height: 844 },
          },
          evaluated: { value: { width: 390, dark: true } },
        })
      const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
      await expect(panel).toBeVisible()
      await expect(panel.getByRole('tab', { name: 'Agent browser fixture', exact: true })).toBeVisible()
      await expect(window.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(url)
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, expectedUrl) =>
              webContents
                .getAllWebContents()
                .find(contents => contents.getURL() === expectedUrl)
                ?.executeJavaScript('document.querySelector("#result").textContent'),
            url,
          ),
        )
        .toBe('Hello Browser agent')
      await expect(window.getByText('Browser interaction verified.', { exact: true })).toBeVisible()
      await app.evaluate(
        ({ webContents }, expectedUrl) =>
          webContents.getAllWebContents().find(contents => contents.getURL() === expectedUrl)
            ?.executeJavaScript(`(() => {
        const button = document.querySelector('#greet');
        button.__reactFiber$fixture = { type: function GreetButton() {}, _debugSource: { fileName: 'src/GreetButton.tsx', lineNumber: 12 } };
        window.pickClickCount = 0;
        button.addEventListener('click', () => window.pickClickCount++);
      })()`),
        url,
      )

      const browserActions = panel.getByRole('button', { name: 'Browser actions', exact: true })
      await browserActions.click()
      await window.getByRole('menuitem', { name: 'Phone (390 × 844)', exact: true }).click()
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, expectedUrl) =>
              webContents
                .getAllWebContents()
                .find(contents => contents.getURL() === expectedUrl)
                ?.executeJavaScript('innerWidth'),
            url,
          ),
        )
        .toBe(390)
      await browserActions.click()
      await window.getByRole('menuitem', { name: 'Light appearance', exact: true }).click()
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, expectedUrl) =>
              webContents
                .getAllWebContents()
                .find(contents => contents.getURL() === expectedUrl)
                ?.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches'),
            url,
          ),
        )
        .toBe(false)

      await panel.getByRole('button', { name: 'Pick element', exact: true }).click()
      await expect(window.getByRole('status').filter({ hasText: 'Select an element in the page.' })).toBeVisible()
      await window.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(window.getByRole('status').filter({ hasText: 'Select an element in the page.' })).not.toBeVisible()
      await expect(window.getByRole('alert').filter({ hasText: 'Browser operation failed.' })).toHaveCount(0)

      await panel.getByRole('button', { name: 'Pick element', exact: true }).click()
      await expect(window.getByRole('status').filter({ hasText: 'Select an element in the page.' })).toBeVisible()
      await pickInPreview(app, url, '#greet')
      await expect(window.getByRole('dialog').getByRole('heading', { name: 'Annotate screenshot' })).toBeVisible()
      const annotation = window.getByRole('dialog', { name: 'Annotate screenshot', exact: true })
      await expect(annotation.locator('svg rect')).toHaveCount(1)
      expect(
        await annotation
          .getByRole('img', { name: 'Screenshot to annotate' })
          .evaluate(image => (image as HTMLImageElement).naturalWidth),
      ).toBeLessThan(390)
      await annotation
        .getByRole('textbox', { name: 'Screenshot instructions' })
        .fill('Adjust spacing for both targets.')
      await annotation.getByRole('button', { name: 'Pick another element' }).click()
      await expect(window.getByRole('status').filter({ hasText: 'Select an element in the page.' })).toBeVisible()
      await pickInPreview(app, url, '#name')
      await expect(annotation.getByRole('img', { name: 'Picked element 1' })).toBeVisible()
      await window.getByRole('button', { name: 'Add to chat', exact: true }).click()
      const prompt = window.getByRole('textbox', { name: 'Prompt', exact: true })
      await expect(prompt.locator('[data-prompt-annotation]')).toHaveCount(1)
      await expect(prompt).not.toContainText('Selector:')
      const chip = prompt.getByRole('button', {
        name: 'Page annotation Adjust spacing for both targets.. Show details',
        exact: true,
      })
      await chip.click()
      await expect(window.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
      await expect(window.getByText('2 elements', { exact: true })).toBeVisible()
      await window.screenshot({ path: test.info().outputPath('annotation-context.png'), fullPage: true })
      await window.keyboard.press('Escape')
      expect(
        await app.evaluate(
          ({ webContents }, expectedUrl) =>
            webContents
              .getAllWebContents()
              .find(contents => contents.getURL() === expectedUrl)
              ?.executeJavaScript('window.pickClickCount'),
          url,
        ),
      ).toBe(0)

      await browserActions.click()
      await window.getByRole('menuitem', { name: 'Pause agent', exact: true }).click()
      await browserActions.click()
      await expect(window.getByRole('menuitem', { name: 'Resume agent', exact: true })).toBeEnabled()
      await window.getByRole('menuitem', { name: 'Resume agent', exact: true }).click()
      await browserActions.click()
      await expect(window.getByRole('menuitem', { name: 'Pause agent', exact: true })).toBeEnabled()
      await window.getByRole('menu').press('Escape')
      await expect(window.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0)

      await prompt.press('Enter')
      await expect
        .poll(() => entries().find(entry => entry.kind === 'annotation-received'))
        .toMatchObject({
          text: expect.stringContaining('Selector: #greet'),
          images: 1,
        })
      const received = entries().find(entry => entry.kind === 'annotation-received')
      expect(received?.text).toContain('Selector: #name')
      expect(received?.text).toContain('Source: src/GreetButton.tsx:12')
      await expect(prompt.locator('[data-prompt-annotation]')).toHaveCount(0)
      const sentMessage = window
        .getByRole('article', { name: 'User message', exact: true })
        .filter({ hasText: 'Adjust spacing for both targets.' })
      const sentChip = sentMessage.getByRole('button', {
        name: 'Page annotation Adjust spacing for both targets.. Show details',
        exact: true,
      })
      await expect(sentChip).toBeVisible()
      await expect(sentMessage.locator('[data-prompt-annotation]')).toHaveCount(1)
      await expect(sentMessage.getByRole('button', { name: /^Remove page annotation/ })).toHaveCount(0)
      await expect(sentMessage).not.toContainText('attachment:')
      await expect(sentMessage).not.toContainText('workspace-screenshot.png')
      await sentChip.click()
      await expect(window.getByText('2 elements', { exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Preview Annotated page crop', exact: true }).click()
      const expandedImage = window.getByRole('dialog', { name: 'Annotated page crop', exact: true })
      await expect(expandedImage.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
      await window.keyboard.press('Escape')
      await window.keyboard.press('Escape')
      await window.reload()
      await expect(sentChip).toBeVisible()
      await sentChip.click()
      await expect(window.getByRole('img', { name: 'Annotated page crop', exact: true })).toBeVisible()
      await expect(window.getByText('2 elements', { exact: true })).toBeVisible()
      await window.screenshot({ path: test.info().outputPath('sent-annotation-context.png'), fullPage: true })
      await window.keyboard.press('Escape')

      const endpoint = entries().find(entry => entry.kind === 'browser-complete')?.url as string
      await expect
        .poll(async () => {
          try {
            await fetch(endpoint)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
      await window.screenshot({ path: test.info().outputPath('agent-browser.png'), fullPage: true })
      expect(pageErrors).toEqual([])
    } finally {
      await launched?.close()
      await new Promise<void>(closed => server.close(() => closed()))
      removeProfile(directory)
    }
  })
}
