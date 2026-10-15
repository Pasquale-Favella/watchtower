import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOpenCodeFileSessionParser,
  discoverOpenCodeFileSessions,
} from '../src/main/pipeline/providers/opencode-file-parser.js'
import {
  createSqliteSessionParser,
  discoverSqliteSessions,
  OPENCODE_FAMILY_1X,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'
import {
  clearCursorWorkspaceMapCache,
  createCursorProvider,
  workspaceFsPath,
} from '../src/main/pipeline/providers/cursor.js'
import { attachWorkspacePaths } from '../src/main/pipeline/providers/cursor.js'
import type { ParsedProviderCall } from '../src/main/pipeline/providers/types.js'

// Provider working-directory emission (#104): sessions from providers that
// currently emit no path carry their working directory through discovery
// (source.workingDirectory, which the scan delta forwards to port-in) and
// through parse (call-level fields, the copilot/codex pattern).

const DIR = 'C:\\work\\watchtower'

function assistantMessage(): string {
  return JSON.stringify({ role: 'assistant', modelID: 'gpt-4o', tokens: { input: 10, output: 5 } })
}

describe('opencode file sessions', () => {
  it('discovers source.workingDirectory and parses call-level paths from meta.directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oc-file-'))
    mkdirSync(join(dataDir, 'storage', 'session', 'proj1'), { recursive: true })
    mkdirSync(join(dataDir, 'storage', 'message', 'sess-1'), { recursive: true })
    mkdirSync(join(dataDir, 'storage', 'part', 'm1'), { recursive: true })
    writeFileSync(
      join(dataDir, 'storage', 'session', 'proj1', 'sess-1.json'),
      JSON.stringify({ id: 'sess-1', directory: DIR, title: 't', time: { created: 1750000000 } }),
    )
    writeFileSync(
      join(dataDir, 'storage', 'message', 'sess-1', 'm1.json'),
      JSON.stringify({
        id: 'm1',
        role: 'assistant',
        modelID: 'gpt-4o',
        time: { created: 1750000000 },
        tokens: { input: 10, output: 5 },
      }),
    )
    writeFileSync(join(dataDir, 'storage', 'part', 'm1', 'p1.json'), JSON.stringify({ type: 'text', text: 'hello' }))

    const sources = await discoverOpenCodeFileSessions(dataDir, 'opencode')
    expect(sources).toHaveLength(1)
    expect(sources[0]!.workingDirectory).toBe(DIR)

    const parser = createOpenCodeFileSessionParser(sources[0]!, new Set(), dataDir, 'opencode')
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.workingDirectory).toBe(DIR)
    expect(calls[0]!.projectPath).toBe(DIR)
  })
})

describe('opencode sqlite sessions', () => {
  it('discovers source.workingDirectory and parses call-level paths from the session row', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'oc-db-'))
    const dbPath = join(dbDir, 'opencode-test.db')
    const setup = new DatabaseSync(dbPath)
    setup.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
    )
    setup.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    setup.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    setup.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL, NULL)').run('sess-1', DIR, 't', 1750000000)
    setup.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('sess-1', 'm1', 1750000000, assistantMessage())
    setup
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
      .run('sess-1', 'm1', 'p1', JSON.stringify({ type: 'text', text: 'hi' }))
    setup.close()

    const config = {
      providerName: 'opencode',
      displayName: 'OpenCode',
      dbDir,
      dbFilePrefix: 'opencode',
      generations: [OPENCODE_FAMILY_1X],
    }
    const sources = await discoverSqliteSessions(config)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.workingDirectory).toBe(DIR)

    const parser = createSqliteSessionParser(sources[0]!, new Set(), config)
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.workingDirectory).toBe(DIR)
    expect(calls[0]!.projectPath).toBe(DIR)
  })

  it('degrades to path-less calls when the session table has no directory column', async () => {
    // Older vendor schema: no `directory` column. Parse must still yield
    // calls (flowing to the orphan bucket downstream) instead of aborting.
    const dbDir = mkdtempSync(join(tmpdir(), 'oc-db-legacy-'))
    const dbPath = join(dbDir, 'opencode-test.db')
    const setup = new DatabaseSync(dbPath)
    setup.exec('CREATE TABLE session (id TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)')
    setup.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    setup.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    setup.prepare('INSERT INTO session VALUES (?, ?, ?, NULL, NULL)').run('sess-1', 't', 1750000000)
    setup.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('sess-1', 'm1', 1750000000, assistantMessage())
    setup
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
      .run('sess-1', 'm1', 'p1', JSON.stringify({ type: 'text', text: 'hi' }))
    setup.close()

    const config = {
      providerName: 'opencode',
      displayName: 'OpenCode',
      dbDir,
      dbFilePrefix: 'opencode',
      generations: [OPENCODE_FAMILY_1X],
    }
    const parser = createSqliteSessionParser(
      { path: `${dbPath}:sess-1`, project: 't', provider: 'opencode' },
      new Set(),
      config,
    )
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.workingDirectory).toBeUndefined()
    expect(calls[0]!.projectPath).toBeUndefined()
  })
})

describe('workspaceFsPath', () => {
  it('decodes local file URIs and refuses remote ones', () => {
    expect(workspaceFsPath('file:///Users/tester/proj')).toBe('/Users/tester/proj')
    expect(workspaceFsPath('file:///C:/work/watchtower')).toBe('C:/work/watchtower')
    expect(workspaceFsPath('file:///Users/tester/my%20proj')).toBe('/Users/tester/my proj')
    expect(workspaceFsPath('vscode-remote://wsl+Ubuntu/home/me/proj')).toBeUndefined()
  })
})

describe('attachWorkspacePaths', () => {
  const call: ParsedProviderCall = {
    sessionId: 'composer-aaa',
    provider: 'cursor',
    model: 'gpt-4o',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2025-01-01T00:00:00.000Z',
    speed: 'standard' as const,
    project: '-Users-tester-proj',
    userMessage: '',
    deduplicationKey: 'k1',
  }

  it('sets the exact checkout on local workspaces without touching other fields', () => {
    const attached = attachWorkspacePaths(call, '/Users/tester/proj')
    expect(attached.projectPath).toBe('/Users/tester/proj')
    expect(attached.workingDirectory).toBe('/Users/tester/proj')
    expect(attached.project).toBe('-Users-tester-proj')
    expect(attached.sessionId).toBe('composer-aaa')
  })

  it('leaves the call untouched when there is no local checkout (orphan path)', () => {
    expect(attachWorkspacePaths(call, undefined)).toBe(call)
  })
})

describe('cursor workspace sessions', () => {
  afterEach(() => clearCursorWorkspaceMapCache())

  function writeWorkspace(root: string, hash: string, folder: string): void {
    const dir = join(root, 'User', 'workspaceStorage', hash)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ folder }))
    const wsDb = new DatabaseSync(join(dir, 'state.vscdb'))
    wsDb.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)')
    wsDb
      .prepare('INSERT INTO ItemTable VALUES (?, ?)')
      .run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: `composer-${hash}` }] }))
    wsDb.close()
  }

  it('discovers source.workingDirectory for local folders and omits it for remote ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-'))
    mkdirSync(join(root, 'User', 'globalStorage'), { recursive: true })
    writeFileSync(join(root, 'User', 'globalStorage', 'state.vscdb'), '')
    writeWorkspace(root, 'aaa', 'file:///Users/tester/proj')
    writeWorkspace(root, 'bbb', 'vscode-remote://wsl+Ubuntu/home/me/proj')

    const provider = createCursorProvider(join(root, 'User', 'globalStorage', 'state.vscdb'))
    const sources = await provider.discoverSessions()
    const local = sources.find(s => s.project === '-Users-tester-proj')
    const remote = sources.find(s => s.project === '-wsl-Ubuntu-home-me-proj')
    expect(local?.workingDirectory).toBe('/Users/tester/proj')
    expect(remote?.workingDirectory).toBeUndefined()
  })
})
