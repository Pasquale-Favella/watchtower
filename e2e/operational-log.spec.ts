import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { dismissOnboarding, launchApp } from './app'
import { invokeRpc } from './rpc-probe'

/**
 * Operational log e2e (spec #126 slice 1): the built app writes parseable
 * JSON lines to `<userData>/logs`; shell notices arrive through typed RPC.
 *
 * Uses `launchApp` directly (not `withApp`): the log directory must be read
 * before `close()` removes the isolated profile.
 */
test('operational log records boot and typed renderer notices as JSON lines', async () => {
  const { app, window, pageErrors, close } = await launchApp()
  try {
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const logDir = join(userDataDir, 'logs')

    const readRecords = (): Record<string, unknown>[] => {
      const files = readdirSync(logDir).filter(file => file.startsWith('operational'))
      const lines: string[] = []
      for (const file of files) {
        lines.push(
          ...readFileSync(join(logDir, file), 'utf8')
            .split('\n')
            .filter(line => line.trim()),
        )
      }
      return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    }

    // Boot record lands once the data worker is ready (before first scan).
    await expect
      .poll(() => readRecords().filter(record => record['event'] === 'boot.ready').length, { timeout: 60_000 })
      .toBe(1)
    expect(readRecords().find(record => record['event'] === 'boot.ready')?.['level']).toBe('info')
    expect(readRecords().find(record => record['event'] === 'boot.ready')?.['context']).toBe('main')

    // Check boot before the initial scan can rotate the bounded log.
    await dismissOnboarding(window)

    // An invalid payload is rejected by the RPC contract and never reaches
    // the renderer-notice log handler or a legacy IPC operation record.
    const invalidNotice = await invokeRpc(window, 'shell:notice', { label: '', location: '' })
    expect(invalidNotice).toEqual({ ok: false })
    expect(readRecords().filter(record => record['event'] === 'renderer.notice')).toHaveLength(0)
    expect(
      readRecords().filter(record => record['event'] === 'ipc.error' && record['op'] === 'log:notice'),
    ).toHaveLength(0)
    expect(JSON.stringify(readRecords())).not.toContain('invalid renderer notice')

    const validNotice = await invokeRpc(window, 'shell:notice', { label: 'orb placement', location: 'horizontal' })
    expect(validNotice.ok).toBe(true)
    await expect.poll(() => readRecords().filter(record => record['event'] === 'renderer.notice').length).toBe(1)
    expect(readRecords().find(record => record['event'] === 'renderer.notice')).toMatchObject({
      context: 'renderer',
      label: 'orb placement',
      location: 'horizontal',
    })

    // Single-writer file: every line parses and carries level + event.
    for (const record of readRecords()) {
      expect(typeof record['level']).toBe('string')
      expect(typeof record['event']).toBe('string')
    }

    expect(pageErrors).toEqual([])
  } finally {
    await close()
  }
})
