import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'

function removeProfile(directory: string): void {
  const absolute = resolve(directory)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-code-responsive-`))
    throw new Error('Unexpected test profile')
  rmSync(absolute, { recursive: true, force: true })
}

test('large file highlighting and complete diff search leave the composer and shell responsive', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-code-responsive-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    execFileSync('git', ['init', repository], { windowsHide: true, stdio: 'pipe' })
    const lines = Array.from(
      { length: 16_000 },
      (_, index) => `export const item${index} = { value: "original-${index}" };`,
    )
    writeFileSync(join(repository, 'large.ts'), lines.join('\n') + '\n')
    execFileSync('git', ['add', '.'], { cwd: repository, windowsHide: true, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Fixture',
      ],
      { cwd: repository, windowsHide: true, stdio: 'pipe' },
    )
    lines[0] = 'export const firstChange = "worker-start";'
    lines[15_999] = 'export const finalChange = "worker-end";'
    writeFileSync(join(repository, 'large.ts'), lines.join('\n') + '\n')
    launched = await launchApp(directory)
    const { window, pageErrors } = launched
    // Parallel app fixtures can occlude this window. Keep their timer policy out of the event-loop measurement.
    await launched.app.evaluate(({ BrowserWindow }) => {
      for (const browserWindow of BrowserWindow.getAllWindows())
        browserWindow.webContents.setBackgroundThrottling(false)
    })
    const workers: string[] = []
    window.on('worker', worker => workers.push(worker.url()))
    await window.bringToFront()
    await dismissOnboarding(window)
    await expect.poll(() => window.evaluate(() => document.visibilityState)).toBe('visible')
    await window.getByRole('combobox', { name: 'Project', exact: true }).click()
    await window.getByRole('option', { name: 'Add project', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Add project', exact: true })
    await dialog.getByRole('option', { name: /^Local folder/ }).click()
    await dialog.getByRole('combobox', { name: 'Project folder', exact: true }).fill(repository)
    await dialog.getByRole('button', { name: /^Add \(/ }).click()
    const header = window.locator('header[aria-label="Chat header"]')
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    const panel = window.getByRole('complementary', { name: 'Right panel', exact: true })
    await panel.getByRole('button', { name: 'Files', exact: true }).click()
    const baseline = await window.evaluate(async () => {
      const gaps: number[] = []
      let previous = performance.now()
      await new Promise<void>(resolveDone => {
        const timer = setInterval(() => {
          const now = performance.now()
          gaps.push(now - previous)
          previous = now
          if (gaps.length === 20) {
            clearInterval(timer)
            resolveDone()
          }
        }, 16)
      })
      return Math.max(...gaps)
    })
    await window.evaluate(() => {
      const state = {
        gaps: [] as number[],
        phases: {} as Record<string, number[]>,
        longTasks: [] as number[],
        phase: 'file',
        previous: performance.now(),
        timer: 0,
        observer: null as PerformanceObserver | null,
      }
      state.observer = new PerformanceObserver(list =>
        state.longTasks.push(...list.getEntries().map(entry => entry.duration)),
      )
      state.observer.observe({ entryTypes: ['longtask'] })
      state.timer = Number(
        globalThis.setInterval(() => {
          const now = performance.now()
          state.gaps.push(now - state.previous)
          ;(state.phases[state.phase] ??= []).push(now - state.previous)
          state.previous = now
        }, 16),
      )
      ;(window as unknown as { responsivenessProbe: typeof state }).responsivenessProbe = state
    })
    await panel.getByRole('tabpanel').locator('button[data-item-path="large.ts"]').click()
    const prompt = window.getByRole('textbox', { name: 'Prompt', exact: true })
    const inputLatencies: number[] = []
    async function fillPrompt(value: string): Promise<void> {
      const start = performance.now()
      await prompt.fill(value)
      await expect(prompt).toHaveText(value)
      inputLatencies.push(performance.now() - start)
    }
    await fillPrompt('The composer remains usable while a large file loads.')
    await expect(panel.getByRole('tabpanel').locator('[data-line]').filter({ hasText: 'firstChange' })).toBeVisible()
    await window.evaluate(() => {
      ;(window as unknown as { responsivenessProbe: { phase: string } }).responsivenessProbe.phase = 'diff'
    })
    await panel.getByRole('button', { name: 'Add panel tab', exact: true }).click()
    await window.getByRole('menuitem', { name: 'Diff', exact: true }).click()
    await fillPrompt('The composer remains usable while a large diff loads.')
    const active = panel.getByRole('tabpanel')
    await active.getByRole('button', { name: 'Expand all files', exact: true }).click()
    await expect(active.locator('[data-line]').filter({ hasText: 'firstChange' })).toBeVisible()
    await window.evaluate(() => {
      ;(window as unknown as { responsivenessProbe: { phase: string } }).responsivenessProbe.phase = 'search'
    })
    await active.getByRole('button', { name: 'Collapse all files', exact: true }).click()
    await active.getByRole('button', { name: 'Find in diff', exact: true }).click()
    await active.getByRole('textbox', { name: 'Search in diff', exact: true }).fill('worker-end')
    await fillPrompt('The composer also remains usable during full-context search.')
    await expect(active.locator('[data-line]').filter({ hasText: 'finalChange' })).toBeVisible()
    await window.evaluate(() => {
      ;(window as unknown as { responsivenessProbe: { phase: string } }).responsivenessProbe.phase = 'hide-show'
    })
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await expect(panel).toBeHidden()
    await header.getByRole('button', { name: 'Right panel', exact: true }).click()
    await expect(panel).toBeVisible()
    const measurement = await window.evaluate(() => {
      const probe = (
        window as unknown as {
          responsivenessProbe: {
            timer: number
            gaps: number[]
            phases: Record<string, number[]>
            longTasks: number[]
            observer: PerformanceObserver | null
          }
        }
      ).responsivenessProbe
      clearInterval(probe.timer)
      probe.observer?.disconnect()
      return {
        gaps: probe.gaps,
        longTasks: probe.longTasks,
        phases: Object.fromEntries(Object.entries(probe.phases).map(([phase, gaps]) => [phase, Math.max(...gaps)])),
      }
    })
    const gaps = measurement.gaps
    const output = test.info().outputPath('renderer-responsiveness.json')
    writeFileSync(
      output,
      JSON.stringify(
        {
          baselineMaxGapMs: baseline,
          maxGapMs: Math.max(...gaps),
          phases: measurement.phases,
          samples: gaps.length,
          inputLatenciesMs: inputLatencies,
          maxLongTaskMs: Math.max(0, ...measurement.longTasks),
          workers,
        },
        null,
        2,
      ),
    )
    await test.info().attach('renderer-responsiveness.json', { path: output, contentType: 'application/json' })
    expect(gaps.length).toBeGreaterThan(20)
    expect(Math.max(...inputLatencies)).toBeLessThan(1000)
    expect(Math.max(0, ...measurement.longTasks)).toBeLessThan(1000)
    expect(Math.max(...gaps)).toBeLessThan(Math.max(1000, baseline * 8))
    expect(workers.some(url => url.includes('code-highlight'))).toBe(true)
    expect(workers.some(url => url.includes('code-processing'))).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await launched?.close()
    removeProfile(directory)
  }
})
