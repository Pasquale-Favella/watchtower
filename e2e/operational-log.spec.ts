import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { dismissOnboarding, launchApp } from './app'

/**
 * Operational log e2e (spec #126 slice 1): the built app writes parseable
 * JSON lines to `<userData>/logs`, and a forced IPC failure is recorded with
 * the operation name and a short code only — never arguments or messages.
 *
 * Uses `launchApp` directly (not `withApp`): the log directory must be read
 * before `close()` removes the isolated profile.
 */
test('operational log records boot and IPC failures as JSON lines', async () => {
  const { app, window, pageErrors, close } = await launchApp()
  try {
    await dismissOnboarding(window)

    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const logDir = join(userDataDir, 'logs')

    const readRecords = (): Record<string, unknown>[] => {
      const files = readdirSync(logDir).filter(file => file.startsWith('operational'))
      const lines: string[] = []
      for (const file of files) {
        lines.push(...readFileSync(join(logDir, file), 'utf8').split('\n').filter(line => line.trim()))
      }
      return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    }

    // Boot record lands once the data worker is ready (before first scan).
    await expect.poll(
      () => readRecords().filter(record => record['event'] === 'boot.ready').length,
      { timeout: 60_000 },
    ).toBe(1)
    expect(readRecords().find(record => record['event'] === 'boot.ready')?.['level']).toBe('info')
    expect(readRecords().find(record => record['event'] === 'boot.ready')?.['context']).toBe('main')

    // Force one IPC failure with an invalid startup mode. The rejection is
    // expected — the record must carry op + code only, never the message.
    const outcome = await window.evaluate(() =>
      (globalThis as unknown as { api: { setLedgerMcpStartupMode: (mode: string) => Promise<unknown> } }).api
        .setLedgerMcpStartupMode('bogus-mode')
        .then(
          () => 'unexpected-ok',
          (err: unknown) => `rejected:${err instanceof Error ? err.message : String(err)}`,
        ),
    )
    expect(outcome).toContain('rejected:')

    await expect.poll(
      () => readRecords().filter(record => record['event'] === 'ipc.error').length,
      { timeout: 30_000 },
    ).toBe(1)
    const ipcError = readRecords().find(record => record['event'] === 'ipc.error')
    expect(ipcError?.['op']).toBe('ledger-mcp:startup:set')
    expect(ipcError?.['code']).toBe('failed')
    expect(JSON.stringify(ipcError)).not.toContain('invalid ledger MCP startup mode')

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
