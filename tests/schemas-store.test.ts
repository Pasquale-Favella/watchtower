import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { LedgerIngest, LedgerQueries } from '../src/core/ports/repository.js'
import { ledgerCallRowSchema } from '../src/shared/schemas/ledger.js'
import { mappedFileSchema } from '../src/shared/schemas/port.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: '/workspace/demo-project/.opencode/sess-1.jsonl',
}

/** Opens a raw second connection to the runtime's db file (WAL allows it). */
function rawDb(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath)
}

describe('store seam under Effect Schema (ADR 0003: read-back parsing)', () => {
  it('a raw SQL row parses through the schema and transforms to the camelCase shape', () => {
    // The schema's input is the snake_case SQL row; its codec produces the
    // camelCase shape with JSON columns parsed. Asserted against a literal
    // raw row so the expected value is independent of the store.
    const rawRow = {
      source_id: 1,
      session_id: 'sess-0',
      turn_index: 0,
      call_index: 0,
      call_key: 'call-1',
      dedup_key: null,
      provider: 'opencode',
      model: 'demo-model',
      timestamp: '2026-07-01T09:00:00.000Z',
      speed: 'standard',
      project: null,
      project_path: null,
      working_directory: null,
      base_cost_usd: 0.42,
      is_estimated: 0,
      savings_usd: 0,
      savings_baseline_model: null,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
      cached_input_tokens: 0,
      reasoning_tokens: 5,
      web_search_requests: 0,
      cache_creation_one_hour_tokens: 0,
      agent_type: null,
      tools_json: '["Edit"]',
      mcp_tools_json: '[]',
      skills_json: '[]',
      subagent_types_json: '[]',
      bash_commands_json: '[]',
      tool_sequence_json: '[]',
      loc_added: null,
      loc_removed: null,
      interrupted: 0,
      user_modified: 0,
      tool_errors: 0,
      edit_failed: 0,
    }
    const parsed = Schema.decodeUnknownSync(ledgerCallRowSchema)(rawRow)
    expect(parsed).toMatchObject({
      sourceId: 1,
      sessionId: 'sess-0',
      callKey: 'call-1',
      provider: 'opencode',
      baseCostUSD: 0.42,
      inputTokens: 100,
      tools: ['Edit'],
      toolSequence: [],
      speed: 'standard',
    })
    // And the whole-set decode accepts an array of such rows in one pass.
    expect(Schema.decodeUnknownSync(Schema.Array(ledgerCallRowSchema))([rawRow])).toHaveLength(1)
  })

  it('a malformed row fails in the ERROR channel, not as a defect', () => {
    // The point of the Wave A migration: `Schema.decodeUnknownEffect` puts a bad
    // row on `E` as a `SchemaError`, where the old `z.array(...).parse` threw
    // into `Cause` as an unmodelled defect.
    const rawRow = { source_id: 1, session_id: 'sess-0', speed: 'turbo' }
    const result = Schema.decodeUnknownResult(ledgerCallRowSchema)(rawRow)
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(Schema.isSchemaError(result.failure)).toBe(true)

    const effect = Schema.decodeUnknownEffect(ledgerCallRowSchema)(rawRow)
    const decoded = Effect.runSync(Effect.result(effect))
    expect(decoded._tag).toBe('Failure')
    if (decoded._tag === 'Failure') expect(Schema.isSchemaError(decoded.failure)).toBe(true)
  })

  it('a corrupted read-back row fails loudly (bad JSON in a *_json column)', () => {
    const { dbPath, runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          ...baseInput,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )

    // Corrupt the stored tools_json column directly, bypassing the write path:
    // read-back validation must catch it instead of hand-rolled casts silently
    // passing garbage through.
    const db = rawDb(dbPath)
    db.prepare("UPDATE ledger_call SET tools_json = '{not-json' WHERE call_key = 'call-1'").run()
    db.close()

    expect(() => runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getCalls()))).toThrow()
  })

  it('a declared-field type mismatch in a row fails loudly (speed not standard/fast)', () => {
    const { dbPath, runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          ...baseInput,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )

    const db = rawDb(dbPath)
    db.prepare("UPDATE ledger_call SET speed = 'turbo' WHERE call_key = 'call-1'").run()
    db.close()

    expect(() => runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getCalls()))).toThrow()
  })
})

describe('port-in seam under Effect Schema (ADR 0002: mapping validation)', () => {
  it('a valid mapping validates against mappedFileSchema', async () => {
    const input = { ...baseInput, verdict: 'new' as const, cachedFile: buildFixtureCachedFile() }
    const { mapFileToLedgerRows } = await import('../src/infrastructure/sqlite/port.js')
    const mapped = mapFileToLedgerRows(input)
    expect(Schema.decodeUnknownResult(mappedFileSchema)(mapped)._tag).toBe('Success')
  })

  it('a mapping with a corrupted declared field is rejected before any ledger write', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    // Corrupt a declared field at the mapping input: mcpInventory must be a
    // string[], and it flows straight into MappedSession — the schema must
    // reject the mapping loudly and nothing may land in the ledger.
    file.mcpInventory = 'not-an-array' as unknown as string[]

    expect(() =>
      runtime.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
            ...baseInput,
            verdict: 'new',
            cachedFile: file,
          }),
        ),
      ),
    ).toThrow()
    expect(runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getCalls()))).toEqual([])
    expect(runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getSessions()))).toEqual([])
  })
})
