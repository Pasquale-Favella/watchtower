import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import { setLedgerMcpStartupMode } from '../src/main/application/ledger-config-commands.js'
import { LedgerConfig } from '../src/main/store/ledger-repository.js'
import { openWorkerRuntime } from '../src/main/worker-runtime.js'

const tempDirs: string[] = []

describe('ledger MCP startup mode storage', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('falls back for invalid writes and corrupt persisted values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-ledger-mcp-mode-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const runtime = openWorkerRuntime(dbPath)
    try {
      const config = runtime.runSync(LedgerConfig)
      expect(runtime.runSync(setLedgerMcpStartupMode('invalid'))).toBe('on-demand')
      expect(runtime.runSync(config.getLedgerMcpStartupMode())).toBe('on-demand')
      runtime.runSync(config.setLedgerMcpStartupMode('at-launch'))
      expect(runtime.runSync(config.getLedgerMcpStartupMode())).toBe('at-launch')
    } finally {
      await runtime.dispose()
    }

    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('UPDATE ledger_mcp_config SET startup_mode = ? WHERE id = 1').run('invalid')
    } finally {
      db.close()
    }

    const reopened = openWorkerRuntime(dbPath)
    try {
      expect(reopened.runSync(Effect.flatMap(LedgerConfig, config => config.getLedgerMcpStartupMode()))).toBe(
        'on-demand',
      )
    } finally {
      await reopened.dispose()
    }
  })
})
