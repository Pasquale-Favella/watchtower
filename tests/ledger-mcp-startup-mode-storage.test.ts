import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { LedgerStore } from '../src/main/store/ledger.js'

const tempDirs: string[] = []

describe('ledger MCP startup mode storage', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('falls back for invalid writes and corrupt persisted values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-ledger-mcp-mode-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const store = new LedgerStore(dbPath)
    try {
      expect(store.setLedgerMcpStartupMode('invalid')).toBe('on-demand')
      expect(store.getLedgerMcpStartupMode()).toBe('on-demand')
      store.setLedgerMcpStartupMode('at-launch')
      expect(store.getLedgerMcpStartupMode()).toBe('at-launch')
    } finally {
      store.close()
    }

    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('UPDATE ledger_mcp_config SET startup_mode = ? WHERE id = 1').run('invalid')
    } finally {
      db.close()
    }

    const reopenedStore = new LedgerStore(dbPath)
    try {
      expect(reopenedStore.getLedgerMcpStartupMode()).toBe('on-demand')
    } finally {
      reopenedStore.close()
    }
  })
})
