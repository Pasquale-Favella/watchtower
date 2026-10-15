import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sqliteHooks = vi.hoisted(() => ({ failPath: '', queryFailure: undefined as Error | undefined }))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    openDatabase(path: string) {
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
          if (path === sqliteHooks.failPath && sql.includes('FROM spans')) throw sqliteHooks.queryFailure
          return db.query<T>(sql, params)
        },
        close: () => db.close(),
      }
    },
  }
})

import { createCopilotProvider } from '../src/main/pipeline/providers/copilot.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''
let closeSpy: ReturnType<typeof vi.spyOn> | undefined

afterEach(() => {
  closeSpy?.mockRestore()
  closeSpy = undefined
  sqliteHooks.failPath = ''
  sqliteHooks.queryFailure = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function tempPath(name: string): string {
  if (!root) root = mkdtempSync(join(tmpdir(), 'watchtower-copilot-sqlite-effect-'))
  return join(root, name)
}

function countDatabaseCloses(): void {
  closeSpy = vi.spyOn(DatabaseSync.prototype, 'close')
}

function makeStore(path: string, rows = 2): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, initiator TEXT, created_at TEXT
    );`)
  db.exec("INSERT INTO sessions VALUES ('session-a', 'C:\\work\\repo', 'owner/repo')")
  for (let index = 1; index <= rows; index++) {
    db.exec(
      `INSERT INTO assistant_usage_events VALUES (${index}, 'session-a', 'gpt-4.1', 100, 20, 10, 5, 0, 'compaction', '2026-03-01T10:00:00.000Z')`,
    )
  }
  db.close()
}

function makeOtel(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT, operation_name TEXT,
      start_time_ms REAL, response_model TEXT
    );
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);`)
  db.exec("INSERT INTO spans VALUES ('chat-1', 'trace-1', 'chat', 1772360000000, 'gpt-4.1')")
  db.exec("INSERT INTO spans VALUES ('chat-2', 'trace-1', 'chat', 1772360002000, 'gpt-4.1')")
  db.exec("INSERT INTO spans VALUES ('tool-1', 'trace-1', 'execute_tool', 1772360001000, NULL)")
  db.exec(`INSERT INTO span_attributes VALUES
    ('chat-1', 'gen_ai.conversation.id', 'conversation-a'),
    ('chat-1', 'gen_ai.response.model', 'gpt-4.1'),
    ('chat-1', 'gen_ai.usage.input_tokens', '12'),
    ('chat-1', 'gen_ai.usage.output_tokens', '4'),
    ('chat-1', 'github.copilot.chat.turn.id', 'turn-a'),
    ('chat-1', 'github.copilot.git.repository', 'owner/repo'),
    ('chat-2', 'gen_ai.conversation.id', 'conversation-a'),
    ('chat-2', 'gen_ai.usage.input_tokens', '3'),
    ('chat-2', 'gen_ai.usage.output_tokens', '2'),
    ('tool-1', 'gen_ai.tool.name', 'bash'),
    ('tool-1', 'gen_ai.tool.call.arguments', '{"command":"npm test"}'),
    ('tool-1', 'gen_ai.conversation.id', 'conversation-a'),
    ('tool-1', 'github.copilot.git.repository', 'owner/repo')`)
  db.close()
}

function source(path: string, sourceType: 'sessionstore' | 'otel'): SessionSource {
  return {
    path,
    project: 'copilot',
    provider: 'copilot',
    sourceType,
    ...(sourceType === 'sessionstore' ? { mtime: '2026-03-01T00:00:00.000Z' } : {}),
  } as SessionSource
}

async function collect(
  parser: ReturnType<ReturnType<typeof createCopilotProvider>['createSessionParser']>,
  onUnparsedCall?: Effect.Effect<void>,
): Promise<ParsedProviderCall[]> {
  if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
  const values = await Effect.runPromise(Stream.runCollect(parser.parseStream(onUnparsedCall)))
  return Array.from(values)
}

describe('Copilot SQLite Effect parsers', () => {
  it('closes the session store exactly once at normal EOF and keeps the project and pricing fields', async () => {
    const path = tempPath('session-store.db')
    makeStore(path, 2)
    countDatabaseCloses()

    const calls = await collect(createCopilotProvider().createSessionParser(source(path, 'sessionstore'), new Set()))

    expect(calls).toHaveLength(2)
    const firstCall = calls[0]
    expect(firstCall).toMatchObject({
      provider: 'copilot',
      sessionId: 'session-a',
      project: 'repo',
      inputTokens: 85,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      workingDirectory: 'C:\\work\\repo',
    })
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('closes an OTel database once when a consumer stops after the first call', async () => {
    const path = tempPath('agent-traces.db')
    makeOtel(path)
    countDatabaseCloses()
    const parser = createCopilotProvider().createSessionParser(source(path, 'otel'), new Set())
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const iterator = Stream.toAsyncIterable(parser.parseStream())[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('OTel parser returned no call')
    expect(first.value).toMatchObject({ sessionId: 'conversation-a', project: 'repo', tools: ['Bash'] })
    await iterator.return?.()

    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the acquired database when parsing is aborted after a yielded call', async () => {
    const path = tempPath('agent-traces-abort.db')
    makeOtel(path)
    countDatabaseCloses()
    const controller = new AbortController()
    const parser = createCopilotProvider().createSessionParser(source(path, 'otel'), new Set(), undefined, {
      signal: controller.signal,
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const iterator = Stream.toAsyncIterable(parser.parseStream())[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort()

    await expect(iterator.next()).rejects.toBeInstanceOf(ScanAbortedError)
    await iterator.return?.()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy parser API and its native SQLite query error', async () => {
    const path = tempPath('query-error.db')
    makeOtel(path)
    const sqliteError = new Error('native query failure')
    sqliteHooks.failPath = path
    sqliteHooks.queryFailure = sqliteError
    countDatabaseCloses()
    const parser = createCopilotProvider().createSessionParser(source(path, 'otel'), new Set())

    await expect(parser.parse().next()).rejects.toBe(sqliteError)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('treats a session-store schema mismatch as empty and closes the acquired handle', async () => {
    const path = tempPath('unused-sibling.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unrelated (valid_but_unused TEXT)')
    db.close()
    countDatabaseCloses()

    const calls = await collect(createCopilotProvider().createSessionParser(source(path, 'sessionstore'), new Set()))

    expect(calls).toEqual([])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('skips an invalid consumed row while accepting its valid sibling with an unused extra field', async () => {
    const path = tempPath('mixed-rows.db')
    makeStore(path, 2)
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE assistant_usage_events ADD COLUMN unused_payload TEXT')
    db.exec("UPDATE assistant_usage_events SET input_tokens = 'invalid', unused_payload = '{not-json}' WHERE id = 1")
    db.close()
    countDatabaseCloses()
    let unparsedCount = 0
    const parser = createCopilotProvider().createSessionParser(source(path, 'sessionstore'), new Set())

    const calls = await collect(
      parser,
      Effect.sync(() => {
        unparsedCount++
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toContain(':2:')
    expect(unparsedCount).toBe(1)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('decodes invalid UTF-8 text through the session-store BLOB projection', async () => {
    const path = tempPath('invalid-utf8-store.db')
    makeStore(path, 1)
    const db = new DatabaseSync(path)
    db.exec("UPDATE assistant_usage_events SET model = CAST(x'80' AS TEXT) WHERE id = 1")
    db.close()

    const calls = await collect(createCopilotProvider().createSessionParser(source(path, 'sessionstore'), new Set()))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('\uFFFD')
  })

  it('rejects non-finite selected OTel usage once after seen admission and before pricing', async () => {
    const path = tempPath('non-finite-otel.db')
    makeOtel(path)
    const db = new DatabaseSync(path)
    db.exec(
      "UPDATE span_attributes SET value = 'Infinity' WHERE span_id = 'chat-1' AND key = 'gen_ai.usage.input_tokens'",
    )
    db.close()
    const seenKeys = new Set<string>()
    let unparsedCount = 0
    const parser = createCopilotProvider().createSessionParser(source(path, 'otel'), seenKeys)

    const calls = await collect(
      parser,
      Effect.sync(() => {
        unparsedCount++
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe('conversation-a')
    expect(seenKeys).toContain('copilot-otel:chat-1')
    expect(seenKeys).toContain('copilot:conversation-a:turn-a')
    expect(unparsedCount).toBe(1)
  })

  it('uses zero for missing numeric attributes and unknown for a blank model', async () => {
    const path = tempPath('otel-defaults.db')
    makeOtel(path)
    const db = new DatabaseSync(path)
    db.exec("DELETE FROM span_attributes WHERE span_id = 'chat-2' AND key = 'gen_ai.usage.input_tokens'")
    db.exec("UPDATE spans SET response_model = '   ' WHERE span_id = 'chat-2'")
    db.close()

    const calls = await collect(createCopilotProvider().createSessionParser(source(path, 'otel'), new Set()))
    const second = calls.find(call => call.deduplicationKey === 'copilot-otel:chat-2')

    expect(second).toMatchObject({ model: 'unknown', inputTokens: 0, outputTokens: 2 })
  })

  it('keeps whitespace-only response and request model attributes on the unknown fallback path', async () => {
    const path = tempPath('otel-blank-model-attributes.db')
    makeOtel(path)
    const db = new DatabaseSync(path)
    db.exec(`
      UPDATE span_attributes SET value = '   '
        WHERE span_id = 'chat-1' AND key = 'gen_ai.response.model';
      DELETE FROM span_attributes
        WHERE span_id = 'chat-2' AND key = 'gen_ai.response.model';
      INSERT INTO span_attributes VALUES ('chat-2', 'gen_ai.request.model', '  ');
    `)
    db.close()

    const calls = await collect(createCopilotProvider().createSessionParser(source(path, 'otel'), new Set()))

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.model)).toEqual(['unknown', 'unknown'])
  })

  it('admits but skips a selected numeric model, and ignores an invalid lower-priority model', async () => {
    const path = tempPath('otel-model-types.db')
    makeOtel(path)
    const db = new DatabaseSync(path)
    db.exec(`
      UPDATE span_attributes SET value = 123
        WHERE span_id = 'chat-1' AND key = 'gen_ai.response.model';
      INSERT INTO span_attributes VALUES ('chat-1', 'gen_ai.request.model', 'gpt-fallback');
      INSERT INTO span_attributes VALUES ('chat-2', 'gen_ai.response.model', 'gpt-4.1');
      INSERT INTO span_attributes VALUES ('chat-2', 'gen_ai.request.model', 456);
    `)
    db.close()
    const seenKeys = new Set<string>()
    let unparsedCount = 0
    const pricing = {
      calculateCost: vi.fn(() => 1),
      calculateLocalModelSavings: () => null,
    }
    const parser = createCopilotProvider().createSessionParser(source(path, 'otel'), seenKeys, undefined, { pricing })

    const calls = await collect(
      parser,
      Effect.sync(() => {
        unparsedCount++
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionId: 'conversation-a', model: 'gpt-4.1' })
    expect(seenKeys).toContain('copilot-otel:chat-1')
    expect(seenKeys).toContain('copilot:conversation-a:turn-a')
    expect(seenKeys).toContain('copilot-otel:chat-2')
    expect(unparsedCount).toBe(1)
    expect(pricing.calculateCost).toHaveBeenCalledTimes(1)
    expect(pricing.calculateCost).toHaveBeenCalledWith('gpt-4.1', 3, 2, 0, 0, 0)
  })

  it('safely decodes an invalid UTF-8 OTel usage attribute and tallies its rejected call', async () => {
    const path = tempPath('invalid-utf8-otel.db')
    makeOtel(path)
    const db = new DatabaseSync(path)
    db.exec(
      "UPDATE span_attributes SET value = CAST(x'80' AS TEXT) WHERE span_id = 'chat-1' AND key = 'gen_ai.usage.input_tokens'",
    )
    db.close()
    let unparsedCount = 0
    const calls = await collect(
      createCopilotProvider().createSessionParser(source(path, 'otel'), new Set()),
      Effect.sync(() => {
        unparsedCount++
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('copilot-otel:chat-2')
    expect(unparsedCount).toBe(1)
  })
})
