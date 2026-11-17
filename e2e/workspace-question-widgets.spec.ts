import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

function removeFixture(directory: string, workspace: string): void {
  if (dirname(directory) !== workspace) throw new Error('Question fixture cleanup escaped the workspace')
  rmSync(directory, { recursive: true, force: true })
}

test('questions preserve multiple selections, custom text and navigation while hiding secret answers in history', async () => {
  const workspace = resolve('.')
  const directory = mkdtempSync(join(workspace, '.watchtower-questions-'))
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
        rollupOptions: { input: resolve('e2e/fixtures/question-widgets.html') },
      },
    })
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('e2e/fixtures/question-widgets-main.mjs'),
        join(directory, 'renderer/question-widgets.html'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const primary = page.getByRole('region', { name: 'Primary questions', exact: true })
    await expect(primary.getByText('Continue on the current branch.', { exact: true })).toBeVisible()
    await expect(primary.getByText('Recommended', { exact: true })).toBeVisible()
    await primary.getByRole('radio', { name: /Main branch/ }).click()
    await expect(primary.getByRole('checkbox', { name: /Lint/ })).toBeVisible()
    await primary.getByRole('checkbox', { name: /Lint/ }).click()
    await primary.getByRole('checkbox', { name: /Tests/ }).click()
    await primary.getByRole('textbox', { name: 'Other answer', exact: true }).fill('Build for desktop')
    await page.getByRole('button', { name: 'Hide questions', exact: true }).click()
    await page.getByRole('button', { name: 'Show questions', exact: true }).click()
    await expect(primary.getByRole('checkbox', { name: /Lint/ })).toHaveAttribute('aria-checked', 'true')
    await expect(primary.getByRole('textbox', { name: 'Other answer', exact: true })).toHaveValue('Build for desktop')
    await primary.getByRole('button', { name: 'Next', exact: true }).click()
    const secret = primary.getByLabel('Your answer', { exact: true })
    await expect(secret).toHaveAttribute('type', 'password')
    await secret.fill('temporary-secret')
    await primary.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(primary.getByRole('checkbox', { name: /Tests/ })).toHaveAttribute('aria-checked', 'true')
    await primary.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(secret).toHaveValue('temporary-secret')
    expect(
      await page.evaluate(() => (globalThis as typeof globalThis & { questionResponse: unknown }).questionResponse),
    ).toBeUndefined()
    await primary.getByRole('button', { name: 'Submit answers', exact: true }).click()
    const submittedQuestion = primary.getByRole('button', { name: /^Question .*Answered$/ })
    await expect(submittedQuestion).toHaveAttribute('aria-expanded', 'false')
    await submittedQuestion.click()
    await expect(primary.getByText('Build for desktop', { exact: true })).toBeVisible()
    await expect(primary.getByText('Hidden answer', { exact: true })).toBeVisible()
    await expect(primary.getByText('temporary-secret', { exact: true })).toHaveCount(0)
    const result = await page.evaluate(
      () => (globalThis as typeof globalThis & { questionResponse: unknown }).questionResponse,
    )
    expect(result).toEqual({
      kind: 'answers',
      answers: { branch: 'main', checks: ['lint', 'test', 'Build for desktop'], secret: 'temporary-secret' },
    })
    await page.screenshot({ path: test.info().outputPath('submitted-answers.png') })
    await page.getByRole('button', { name: 'Use strict choices', exact: true }).click()
    await expect(primary.getByRole('textbox', { name: 'Other answer', exact: true })).toHaveCount(0)
    await expect(primary.getByRole('button', { name: 'Submit answers', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Toggle parallel questions', exact: true }).click()
    const parallel = page.getByRole('region', { name: 'Parallel questions', exact: true })
    await parallel.getByRole('radio', { name: /Alpha/ }).focus()
    await page.keyboard.press('2')
    await expect(parallel.getByRole('radio', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true')
    await expect(primary.getByRole('radio', { name: /Beta/ })).toHaveAttribute('aria-checked', 'false')
    await expect(primary.getByRole('button', { name: 'Submit answers', exact: true })).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('question-widgets.png') })
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    removeFixture(directory, workspace)
  }
})
