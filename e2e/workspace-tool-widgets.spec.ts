import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

test('conversation widgets retain safe output, user disclosure choices and output scroll position', async () => {
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-widgets-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await build({
      configFile: false,
      root: resolve('e2e/fixtures'),
      base: './',
      plugins: [tailwindcss()],
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': resolve('src') } },
      logLevel: 'error',
      build: {
        outDir: join(directory, 'renderer'),
        rollupOptions: { input: resolve('e2e/fixtures/workspace-tool-widgets.html') },
      },
    })
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('e2e/fixtures/workspace-tool-widgets-main.mjs'),
        join(directory, 'renderer/workspace-tool-widgets.html'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const command = page.getByRole('article', { name: 'Command widget', exact: true })
    const output = command.getByRole('region', { name: 'Output', exact: true })
    const viewport = output.locator('pre')
    await expect(command.getByRole('button', { name: 'Bash: Running', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await command.getByRole('button', { name: 'Bash: Running', exact: true }).click()
    await expect(command.getByRole('button', { name: 'Bash: Running', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(output).toContainText('All tests passed')
    expect(
      await viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight),
    ).toBeLessThanOrEqual(2)
    await viewport.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.getByRole('button', { name: 'Append output', exact: true }).click()
    await expect(output).toContainText('new output line')
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(0)
    await viewport.evaluate(element => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    await page.getByRole('button', { name: 'Append output', exact: true }).click()
    await expect
      .poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight))
      .toBeLessThanOrEqual(2)
    await output.getByRole('button', { name: 'Wrap output', exact: true }).click()
    await expect(viewport).toHaveCSS('white-space', 'pre-wrap')
    await output.getByRole('button', { name: 'Copy output', exact: true }).click()
    expect(await page.evaluate(() => Reflect.get(globalThis, 'widgetClipboard'))).toContain('All tests passed\nline 0')
    expect(await page.evaluate(() => Reflect.get(globalThis, 'widgetClipboard'))).not.toContain('\u001b')
    await page.getByRole('button', { name: 'Finish command', exact: true }).click()
    await expect(command.getByRole('button', { name: 'Bash: Completed', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await page.getByRole('button', { name: 'Fail command', exact: true }).click()
    await expect(command.getByRole('button', { name: 'Bash: Failed', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(command.getByRole('region', { name: 'Error', exact: true })).toContainText('exited with code 1')
    await command.getByRole('button', { name: 'Bash: Failed', exact: true }).click()
    await expect(command.getByRole('button', { name: 'Bash: Failed', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await page.getByRole('button', { name: 'Finish command', exact: true }).click()
    await expect(command.getByRole('button', { name: 'Bash: Completed', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    const activity = page.getByRole('article', { name: 'Activity group widget', exact: true })
    const firstActivity = activity.getByRole('button', { name: 'Bash: Running', exact: true })
    await expect(firstActivity).toHaveAttribute('aria-expanded', 'false')
    await firstActivity.click()
    await expect(firstActivity).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: 'Add activity tool', exact: true }).click()
    const activityGroup = activity.getByRole('button', { name: /Ran 2 commands/ })
    await expect(activityGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(activity.getByRole('button', { name: 'Bash: Running', exact: true }).first()).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await page.getByRole('button', { name: 'Complete activity group', exact: true }).click()
    await expect(activity.getByRole('button', { name: 'Bash: Completed', exact: true }).first()).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await activity.getByRole('button', { name: /Ran 2 commands/ }).click()
    await expect(activity.getByRole('button', { name: /Ran 2 commands/ })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Fail second activity', exact: true }).click()
    await expect(activity.getByRole('button', { name: /Ran 2 commands/ })).toHaveAttribute('aria-expanded', 'false')
    await activity.getByRole('button', { name: /Ran 2 commands/ }).click()
    await expect(activity.getByRole('button', { name: /Ran 2 commands/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(activity.getByRole('button', { name: 'Bash: Completed', exact: true }).first()).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(activity.getByRole('button', { name: 'Bash: Failed', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await page.getByRole('button', { name: 'Complete activity group', exact: true }).click()
    const completedFold = page.getByRole('article', { name: 'Completed fold widget', exact: true })
    const foldToggle = completedFold.getByRole('button', { name: /^Worked/ })
    await expect(foldToggle).toHaveAttribute('aria-expanded', 'false')
    await foldToggle.click()
    const foldGroup = completedFold.getByRole('button', { name: /Ran 2 commands/ })
    await expect(foldGroup).toHaveAttribute('aria-expanded', 'false')
    await foldGroup.click()
    const foldedFirstTool = completedFold.getByRole('button', { name: 'Bash: Completed', exact: true }).first()
    await foldedFirstTool.click()
    await page.getByRole('button', { name: 'Fail second activity', exact: true }).click()
    await expect(foldToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(foldGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(foldedFirstTool).toHaveAttribute('aria-expanded', 'true')
    await foldToggle.click()
    await expect(foldToggle).toHaveAttribute('aria-expanded', 'false')
    await foldToggle.click()
    await expect(foldGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(foldedFirstTool).toHaveAttribute('aria-expanded', 'true')
    const reasoning = page.getByRole('article', { name: 'Reasoning widget', exact: true })
    const manual = page.getByRole('article', { name: 'Manual reasoning widget', exact: true })
    await expect(reasoning.getByRole('button', { name: /^Thinking…/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(
      manual.getByRole('button', { name: 'Thinking… A manually expanded thought remains available.' }),
    ).toHaveAttribute('aria-expanded', 'false')
    await manual.getByRole('button', { name: /^Thinking…/ }).click()
    await expect(manual.getByRole('button', { name: /^Thinking…/ })).toHaveAttribute('aria-expanded', 'true')
    const planWidget = page.getByRole('article', { name: 'Plan widget', exact: true })
    await expect(planWidget.getByRole('button', { name: /Plan/ })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Finish reasoning and plan', exact: true }).click()
    await expect(reasoning.getByRole('button', { name: /Reasoning Checking/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(manual.getByRole('button', { name: 'Reasoning', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(planWidget.getByRole('button', { name: /Plan/ })).toHaveAttribute('aria-expanded', 'false')
    expect(await manual.locator('.watchtower-markdown p').evaluate(element => getComputedStyle(element).color)).toBe(
      await page.locator('main').evaluate(element => getComputedStyle(element).color),
    )
    const plan = page.getByRole('article', { name: 'Plan widget', exact: true })
    await plan.getByRole('button', { name: /Plan/ }).click()
    await expect(plan.getByRole('progressbar', { name: 'Plan progress' })).toHaveAttribute('value', '3')
    await plan.getByRole('button', { name: 'Copy plan', exact: true }).click()
    expect(await page.evaluate(() => Reflect.get(globalThis, 'widgetClipboard'))).toBe(
      'Apply the change and verify it.\n\n- [x] Inspect the **current behavior**\n- [x] Implement changes\n- [x] Run checks',
    )
    const files = page.getByRole('article', { name: 'File changes widget', exact: true })
    await files.getByRole('button', { name: 'FileChange: Completed', exact: true }).click()
    await files.getByRole('button', { name: 'src/main.ts Modified', exact: true }).click()
    await expect(files.getByRole('region', { name: 'Patch', exact: true })).toContainText('-old\n+new')
    await expect(files.getByRole('button', { name: 'src/new.ts Added', exact: true })).toBeDisabled()
    const unknown = page.getByRole('article', { name: 'Unknown widget', exact: true })
    await unknown.getByRole('button', { name: 'Custom: Status unavailable', exact: true }).click()
    await expect(unknown.getByRole('region', { name: 'Input', exact: true })).toContainText('<script>')
    await expect(unknown.locator('script')).toHaveCount(0)
    await expect(unknown.getByRole('button', { name: /javascript:/ })).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(globalThis, 'widgetExecuted'))).toBeUndefined()
    await page.screenshot({ path: test.info().outputPath('conversation-widgets-dark.png'), fullPage: true })
    await page.getByRole('button', { name: 'Toggle theme', exact: true }).click()
    await page.setViewportSize({ width: 720, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('conversation-widgets-light.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
