import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { LedgerStore } from '../src/main/store/ledger.js'
import {
  currencyRateRowSchema,
  ledgerCallRowSchema,
  ledgerSessionRowSchema,
  ledgerSourceRowSchema,
  ledgerTurnRowSchema,
  modelAliasRowSchema,
  priceOverrideRowSchema,
} from '../src/shared/schemas/ledger.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'

const tempDirs: string[] = []

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-ledger-'))
  tempDirs.push(dir)
  return new LedgerStore(join(dir, 'data.db'))
}

/** Parity introspection seam: a temp store plus a direct read-only handle
 * onto its database file, both closed afterwards. The #97/#98 gates share
 * this two-handle shape instead of repeating the open/close. */
function withTempLedgerReadOnly(fn: (ro: DatabaseSync) => void): void {
  const store = makeStore()
  try {
    const ro = new DatabaseSync(store.dbPath, { readOnly: true })
    try {
      fn(ro)
    } finally {
      ro.close()
    }
  } finally {
    store.close()
  }
}

// Zod shape introspection for the parity gates below. The row schemas are
// `z.object().transform()` pipes in Zod v4, so the storage-side input shape
// lives at `.def.in`. JSON columns are the pipe fields (string through
// `JSON.parse`); every other column is a scalar.
type ZodInputField = { def: { type: string } }
type ZodPipedObject = {
  def: {
    in?: { def: { shape?: Record<string, ZodInputField> } }
    shape?: Record<string, ZodInputField>
  }
}

function zodInputShape(schema: unknown): Record<string, ZodInputField> {
  const piped = schema as ZodPipedObject
  const pipedShape = piped.def.in?.def.shape
  if (pipedShape !== undefined) return pipedShape
  const directShape = piped.def.shape
  if (directShape !== undefined) return directShape
  return {}
}

function zodInputKeys(schema: unknown): string[] {
  return Object.keys(zodInputShape(schema)).sort()
}

function zodJsonKeys(schema: unknown): string[] {
  const shape = zodInputShape(schema)
  return Object.entries(shape)
    .filter(([, field]) => field.def.type === 'pipe')
    .map(([name]) => name)
    .sort()
}

function jsonIsNonEmpty(raw: string): boolean {
  const parsed: unknown = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed.length > 0
  if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length > 0
  return true
}

afterEach(() => {
  // temp dirs are left to the OS; only the store handle is closed by tests
  tempDirs.splice(0)
})

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: FIXTURE_SOURCE_PATH,
  repoUrl: 'https://github.com/acme/demo-project',
}

describe('LedgerStore (the store seam: port-in → read back)', () => {
  it('opens green field: four ledger tables + scoped-read indexes, no report/metrics tables', () => {
    const store = makeStore()

    const tables = store.getTableNames()
    expect(tables).toEqual(expect.arrayContaining(['ledger_source', 'ledger_session', 'ledger_turn', 'ledger_call']))
    expect(tables).not.toContain('report')
    expect(tables).not.toContain('per_call_cost')
    expect(tables).not.toContain('daily_spend')
    expect(tables).not.toContain('tally')
    expect(tables).not.toContain('task_breakdown')
    expect(tables).not.toContain('agent_breakdown')
    expect(tables).not.toContain('ratio_metrics')

    const indexes = store.getIndexNames('ledger_call')
    expect(indexes.sort()).toEqual(
      [
        'idx_ledger_call_timestamp',
        'idx_ledger_call_session',
        'idx_ledger_call_model',
        'idx_ledger_call_project',
        'idx_ledger_call_provider',
        'idx_ledger_call_provider_timestamp',
        'idx_ledger_call_source_timestamp',
      ].sort(),
    )
    // The scoped turn reads filter on `timestamp` and `(source_id, timestamp)`.
    expect(store.getIndexNames('ledger_turn').sort()).toEqual(
      ['idx_ledger_turn_timestamp', 'idx_ledger_turn_source_timestamp'].sort(),
    )

    store.close()
  })

  it('ports a new file: source/session/turn/call rows land and read back faithfully', () => {
    const store = makeStore()
    const result = store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    expect(result.verdict).toBe('new')
    expect(result.inserted).toEqual({ sessions: 1, turns: 1, calls: 1 })

    const sources = store.getSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      provider: 'opencode',
      envFingerprint: 'env-demo',
      filePath: FIXTURE_SOURCE_PATH,
      repoUrl: 'https://github.com/acme/demo-project',
    })

    const sessions = store.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: 'sess-0',
      project: 'demo-project',
      projectPath: '/workspace/demo-project',
      canonicalProject: 'demo-project',
      canonicalCwd: '/workspace/demo-project',
      title: 'Refactor the auth module',
      isSidechain: 0,
      everHadBranch: 0,
    })

    const turns = store.getTurns()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      sessionId: 'sess-0',
      turnIndex: 0,
      category: 'refactoring',
      subCategory: null,
      retries: 0,
      hasEdits: 1,
    })

    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'sess-0',
      turnIndex: 0,
      callIndex: 0,
      callKey: 'call-1',
      provider: 'opencode',
      model: 'demo-model',
      timestamp: '2026-07-01T09:00:00.000Z',
      speed: 'standard',
      baseCostUSD: 0.42,
      isEstimated: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      reasoningTokens: 5,
      tools: ['Edit'],
    })

    store.close()
  })

  it('re-inserting the same file is idempotent: the call_key constraint rejects duplicates', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const again = store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    expect(again.inserted).toEqual({ sessions: 0, turns: 0, calls: 0 })
    expect(store.getCalls()).toHaveLength(1)
    expect(store.getTurns()).toHaveLength(1)
    expect(store.getSessions()).toHaveLength(1)

    store.close()
  })

  it('an appended file inserts only its new rows', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    const appended = buildFixtureCachedFile()
    appended.turns.push(buildFixtureCachedTurn(1, 'Add the new endpoint'))
    const result = store.portIn({ ...baseInput, verdict: 'appended', cachedFile: appended })

    expect(result.inserted).toEqual({ sessions: 0, turns: 1, calls: 1 })
    expect(store.getTurns()).toHaveLength(2)
    expect(store.getCalls()).toHaveLength(2)

    store.close()
  })

  it('a modified file replaces its rows atomically', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    const modified = buildFixtureCachedFile()
    const modifiedTurn = modified.turns[0]
    if (modifiedTurn === undefined) throw new Error('test invariant violated: expected a turn')
    const call = modifiedTurn.calls[0]
    if (call === undefined) throw new Error('test invariant violated: expected a call')
    call.costUSD = 0.99
    call.usage = { ...call.usage, inputTokens: 500 }
    const result = store.portIn({ ...baseInput, verdict: 'modified', cachedFile: modified })

    expect(result.inserted).toEqual({ sessions: 1, turns: 1, calls: 1 })
    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.baseCostUSD).toBeCloseTo(0.99, 6)
    expect(calls[0]?.inputTokens).toBe(500)

    store.close()
  })

  it('an unchanged file touches nothing', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    const result = store.portIn({ ...baseInput, verdict: 'unchanged', cachedFile: buildFixtureCachedFile() })

    expect(result.inserted).toEqual({ sessions: 0, turns: 0, calls: 0 })
    expect(store.getCalls()).toHaveLength(1)

    store.close()
  })

  it('an unchanged file whose source was never ported (warm cache met by an empty ledger) ports its rows', () => {
    const store = makeStore()
    // The post-migration case: the on-disk session cache is warm (fingerprints
    // match) but the ledger has never seen this source — e.g. an existing
    // install whose cache predates the ledger. The `unchanged` verdict must be
    // a first port, not a no-op, or those providers vanish from the app.
    const result = store.portIn({ ...baseInput, verdict: 'unchanged', cachedFile: buildFixtureCachedFile() })

    expect(result.inserted).toEqual({ sessions: 1, turns: 1, calls: 1 })
    expect(store.getSources()).toHaveLength(1)
    expect(store.getCalls()).toHaveLength(1)

    // A later warm scan now finds the source present: `unchanged` is a no-op
    // again — the ledger is its own resume marker, nothing double-counts.
    const again = store.portIn({ ...baseInput, verdict: 'unchanged', cachedFile: buildFixtureCachedFile() })
    expect(again.inserted).toEqual({ sessions: 0, turns: 0, calls: 0 })
    expect(store.getCalls()).toHaveLength(1)

    store.close()
  })

  it('uses the cached turn’s sessionId and the discovery-time project when the cache carries no project metadata', () => {
    const store = makeStore()
    // The real Copilot case: `events.jsonl` under a session-UUID directory with
    // NO canonicalProjectName/canonicalCwd/workingDirectory on the cached file
    // (only Claude worktrees populate those). The discovery-time `project`
    // (the OTel repo name) and `workingDirectory` (workspace.yaml cwd) must
    // win over the directory-UUID fallback, and the session id must come from
    // the cached turns, not the file basename ('events').
    const file = buildFixtureCachedFile()
    delete (file as { canonicalProjectName?: string }).canonicalProjectName
    delete (file as { canonicalCwd?: string }).canonicalCwd
    delete (file as { workingDirectory?: string }).workingDirectory
    const copilotTurn = file.turns[0]
    if (copilotTurn === undefined) throw new Error('test invariant violated: expected a turn')
    copilotTurn.sessionId = '9b702997-3777-4470-8cbb-961e462d9f29'

    store.portIn({
      provider: 'copilot',
      envFingerprint: 'env-demo',
      filePath: 'C:\\Users\\demo\\.copilot\\session-state\\9b702997-3777-4470-8cbb-961e462d9f29\\events.jsonl',
      verdict: 'new',
      cachedFile: file,
      project: 'my-repo',
      workingDirectory: 'C:\\Users\\demo\\work\\my-repo',
    })

    const sessions = store.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: '9b702997-3777-4470-8cbb-961e462d9f29',
      project: 'my-repo',
      projectPath: 'C:\\Users\\demo\\work\\my-repo',
      workingDirectory: 'C:\\Users\\demo\\work\\my-repo',
      canonicalProject: null,
      canonicalCwd: null,
    })
    expect(store.getSources()[0]).toMatchObject({ provider: 'copilot', project: 'my-repo' })
    expect(store.getCalls()[0]?.project).toBe('my-repo')

    store.close()
  })

  it('reads back a source whose fingerprint dev/ino exceed Number.MAX_SAFE_INTEGER (NTFS inode) without throwing', () => {
    const store = makeStore()
    // Windows NTFS inode numbers routinely exceed 2^53. node:sqlite throws
    // ERR_OUT_OF_RANGE when a stored INTEGER can't be represented as a JS
    // number, so getSources() must read them back as digit-exact text.
    const file = buildFixtureCachedFile()
    file.fingerprint = { ...file.fingerprint, dev: 2 ** 53, ino: 2 ** 53 + 2 }
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const sources = store.getSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.fingerprint.dev).toBe(String(2 ** 53))
    expect(sources[0]?.fingerprint.ino).toBe(String(2 ** 53 + 2))
    expect(sources[0]?.fingerprint.mtimeMs).toBe(1_751_300_000_000)
    expect(sources[0]?.fingerprint.sizeBytes).toBe(4096)

    store.close()
  })

  it('keeps an evicted source’s rows; deleteSource removes only that source; clear() drops all ledger data', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.portIn({
      ...baseInput,
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/Users/demo/.codex/other/sess-1.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })

    expect(store.getCalls()).toHaveLength(2)

    store.deleteSource('codex', 'env-demo', '/Users/demo/.codex/other/sess-1.jsonl')
    expect(store.getSources()).toHaveLength(1)
    expect(store.getCalls()).toHaveLength(1)

    store.clear()
    expect(store.getSources()).toEqual([])
    expect(store.getSessions()).toEqual([])
    expect(store.getTurns()).toEqual([])
    expect(store.getCalls()).toEqual([])

    store.close()
  })

  it('clear() reclaims disk space, so the Settings sizes visibly drop', () => {
    const store = makeStore()
    for (let i = 0; i < 200; i++) {
      store.portIn({
        ...baseInput,
        filePath: `/Users/demo/.local/share/opencode/demo-project/sess-${i}.jsonl`,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
    }
    expect(store.getSources()).toHaveLength(200)
    const before = statSync(store.dbPath).size

    store.clear()

    expect(store.getSources()).toEqual([])
    // Without VACUUM + WAL checkpoint the file keeps its freelist pages and
    // statSync reports the same size — the Privacy & data pane then looks
    // untouched after a clear.
    expect(statSync(store.dbPath).size).toBeLessThan(before)

    // The store stays usable after the reclaim.
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    expect(store.getSources()).toHaveLength(1)

    store.close()
  })

  it('clear() still deletes when the reclaim step fails (locked VACUUM)', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    expect(store.getSources()).toHaveLength(1)

    // Force the best-effort reclaim path: a VACUUM that cannot take its
    // exclusive lock (transient file lock, I/O error) must not fail the
    // clear — the DELETEs are already committed.
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
    const realExec = db.exec.bind(db)
    db.exec = (sql: string): void => {
      if (/VACUUM/.test(sql)) throw new Error('SQLITE_LOCKED: database table is locked')
      realExec(sql)
    }
    try {
      store.clear()
    } finally {
      db.exec = realExec
    }

    expect(store.getSources()).toEqual([])
    expect(store.getCalls()).toEqual([])

    store.close()
  })

  it('repoUrl is captured per source at port-in and read back without a rescan', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    expect(store.getSources()[0]?.repoUrl).toBe('https://github.com/acme/demo-project')

    store.close()
  })

  it('carries the git branch forward and persists classification + PR refs per turn', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    const prTurn = file.turns[0]
    if (prTurn === undefined) throw new Error('test invariant violated: expected a turn')
    prTurn.prRefs = ['https://github.com/acme/demo-project/pull/7']
    file.turns.push({ ...buildFixtureCachedTurn(1, 'Add the new endpoint'), gitBranch: 'feature/auth' })

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const turns = store.getTurns()
    expect(turns).toHaveLength(2)
    expect(turns[0]?.gitBranch).toBeNull()
    expect(turns[1]?.gitBranch).toBe('feature/auth')
    expect(turns[0]?.prRefs).toEqual(['https://github.com/acme/demo-project/pull/7'])
    expect(turns[1]?.category).toBe('feature')
    expect(store.getSessions()[0]?.prLinks).toEqual(['https://github.com/acme/demo-project/pull/7'])
    expect(store.getSessions()[0]?.everHadBranch).toBe(1)

    store.close()
  })

  it('round-trips bash commands per call and ambiguous spawn ids per session', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile({
      ambiguousSpawnAgentIds: ['spawn-ambiguous-1'],
    })
    const bashTurn = file.turns[0]
    if (bashTurn === undefined) throw new Error('test invariant violated: expected a turn')
    const bashCall = bashTurn.calls[0]
    if (bashCall === undefined) throw new Error('test invariant violated: expected a call')
    bashCall.bashCommands = ['npm test', 'git status']

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bashCommands).toEqual(['npm test', 'git status'])

    const sessions = store.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.ambiguousSpawnAgentIds).toEqual(['spawn-ambiguous-1'])

    store.close()
  })

  it('round-trips per-call tool sequence bytes (overview/optimize need it)', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    const toolTurn = file.turns[0]
    if (toolTurn === undefined) throw new Error('test invariant violated: expected a turn')
    const toolCall = toolTurn.calls[0]
    if (toolCall === undefined) throw new Error('test invariant violated: expected a call')
    toolCall.toolSequence = [
      [
        { tool: 'Edit', file: 'src/auth.ts' },
        { tool: 'Bash', command: 'npm test' },
      ],
      [{ tool: 'Read', file: 'src/auth.ts' }],
    ]

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolSequence).toEqual([
      [
        { tool: 'Edit', file: 'src/auth.ts' },
        { tool: 'Bash', command: 'npm test' },
      ],
      [{ tool: 'Read', file: 'src/auth.ts' }],
    ])

    store.close()
  })

  it('config writes are pure upserts and survive clear()', () => {
    const store = makeStore()
    store.setModelAlias('proxy-model', 'claude-sonnet-4.5')
    store.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 })
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-07-01T00:00:00.000Z' })
    store.setDisplayCurrency('EUR')
    store.setRefreshCadence('5m')
    store.dismissSkill('bash', 'git commit', 'not-a-skill')

    expect(store.getModelAliases()).toEqual([{ model: 'proxy-model', aliasOf: 'claude-sonnet-4.5' }])
    expect(store.getPriceOverrides()).toEqual([
      { model: 'demo-model', inputPricePerMillion: 3, outputPricePerMillion: 15 },
    ])
    expect(store.getCurrencyRate('EUR')).toEqual({
      code: 'EUR',
      symbol: '€',
      rate: 0.92,
      updatedAt: '2026-07-01T00:00:00.000Z',
    })
    expect(store.getDisplayCurrency()).toBe('EUR')
    expect(store.getRefreshCadence()).toBe('5m')
    expect(store.getSkillDismissals()).toHaveLength(1)

    // a second upsert overwrites, never appends
    store.setPriceOverride('demo-model', { inputPricePerMillion: 4, outputPricePerMillion: 16 })
    expect(store.getPriceOverrides()).toEqual([
      { model: 'demo-model', inputPricePerMillion: 4, outputPricePerMillion: 16 },
    ])

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.clear()

    expect(store.getSources()).toEqual([])
    expect(store.getModelAliases()).toEqual([{ model: 'proxy-model', aliasOf: 'claude-sonnet-4.5' }])
    expect(store.getPriceOverrides()).toEqual([
      { model: 'demo-model', inputPricePerMillion: 4, outputPricePerMillion: 16 },
    ])
    expect(store.getCurrencyRate('EUR')).not.toBeNull()
    expect(store.getDisplayCurrency()).toBe('EUR')
    expect(store.getRefreshCadence()).toBe('5m')
    expect(store.getSkillDismissals()).toEqual([
      { source: 'bash', name: 'git commit', reason: 'not-a-skill', created: expect.any(String) },
    ])

    store.close()
  })

  it('skill dismissals upsert per pattern and are a pure upsert', () => {
    const store = makeStore()
    expect(store.getSkillDismissals()).toEqual([])

    store.dismissSkill('skill', 'data-fetch', 'too-specific')
    store.dismissSkill('bash', 'git commit', 'one-off')
    expect(store.getSkillDismissals().map(d => [d.source, d.name, d.reason])).toEqual([
      ['skill', 'data-fetch', 'too-specific'],
      ['bash', 'git commit', 'one-off'],
    ])

    // Re-dismissing the same pattern overwrites the reason, never appends.
    store.dismissSkill('skill', 'data-fetch', 'not-a-skill')
    expect(store.getSkillDismissals().map(d => [d.source, d.name, d.reason])).toEqual([
      ['skill', 'data-fetch', 'not-a-skill'],
      ['bash', 'git commit', 'one-off'],
    ])

    store.close()
  })
})

describe('LedgerStore scoped reads (query-scaling #139)', () => {
  function portDatedSession(
    store: LedgerStore,
    spec: { provider: string; filePath: string; sessionId: string; date: string },
  ): void {
    const ts = new Date(`${spec.date}T12:00:00`).toISOString()
    const call = { ...buildFixtureCachedCall(0), provider: spec.provider, timestamp: ts }
    const turn = buildFixtureCachedTurn(0, 'task', { sessionId: spec.sessionId, timestamp: ts, calls: [call] })
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: spec.filePath,
      verdict: 'new',
      cachedFile: buildFixtureCachedFile({ turns: [turn] }),
    })
  }

  function portScopedFixtures(store: LedgerStore): void {
    portDatedSession(store, {
      provider: 'claude',
      filePath: '/cache/claude/old.jsonl',
      sessionId: 'sess-old',
      date: '2026-06-01',
    })
    portDatedSession(store, {
      provider: 'claude',
      filePath: '/cache/claude/new.jsonl',
      sessionId: 'sess-new',
      date: '2026-07-20',
    })
    portDatedSession(store, {
      provider: 'opencode',
      filePath: '/cache/opencode/other.jsonl',
      sessionId: 'sess-other',
      date: '2026-07-20',
    })
  }

  it('filters calls and turns by provider at the SQL read', () => {
    const store = makeStore()
    portScopedFixtures(store)

    expect(store.getCallsScoped({ provider: 'claude' })).toHaveLength(2)
    expect(store.getTurnsScoped({ provider: 'claude' })).toHaveLength(2)
    expect(store.getSessionsScoped({ provider: 'claude' })).toHaveLength(2)
    expect(store.getCallsScoped({ provider: 'opencode' })).toHaveLength(1)
    expect(store.getCallsScoped({ provider: 'nope' })).toEqual([])

    store.close()
  })

  it('filters calls and turns by timestamp range at the SQL read', () => {
    const store = makeStore()
    portScopedFixtures(store)

    const july = store.getCallsScoped({ start: '2026-07-01T00:00:00.000Z', end: '2026-07-31T23:59:59.999Z' })
    expect(july.map(c => c.sessionId).sort()).toEqual(['sess-new', 'sess-other'])
    const turns = store.getTurnsScoped({ start: '2026-07-01T00:00:00.000Z', end: '2026-07-31T23:59:59.999Z' })
    expect(turns.map(t => t.sessionId).sort()).toEqual(['sess-new', 'sess-other'])

    store.close()
  })

  it('combines provider and range, matching the in-memory filter exactly', () => {
    const store = makeStore()
    portScopedFixtures(store)

    const filter = { provider: 'claude', start: '2026-07-01T00:00:00.000Z', end: '2026-07-31T23:59:59.999Z' }
    const scoped = store.getCallsScoped(filter)
    expect(scoped.map(c => c.sessionId)).toEqual(['sess-new'])

    // Parity: the scoped read returns exactly what filtering the full read
    // in memory would produce (same rows, same order).
    const claudeSources = new Set(store.getSourceIdsForProvider('claude'))
    const filterStart = filter.start
    if (filterStart === undefined) throw new Error('test invariant violated: expected a start')
    const filterEnd = filter.end
    if (filterEnd === undefined) throw new Error('test invariant violated: expected an end')
    const expected = store
      .getCalls()
      .filter(c => claudeSources.has(c.sourceId) && c.timestamp >= filterStart && c.timestamp <= filterEnd)
    expect(scoped).toEqual(expected)

    store.close()
  })

  it('discovers in-range session keys, then loads those sessions full history', () => {
    const store = makeStore()
    portScopedFixtures(store)

    const keys = store.getCallSessionKeysInRange('2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', 'claude')
    expect(keys).toHaveLength(1)
    // Full history for the touched session (here one turn); untouched
    // sessions never load.
    expect(store.getTurnsForSessionKeys(keys)).toHaveLength(1)
    expect(store.getCallsForSessionKeys(keys)).toHaveLength(1)
    expect(store.getSessionsForKeys(keys).map(s => s.sessionId)).toEqual(['sess-new'])
    expect(store.getTurnsForSessionKeys([])).toEqual([])
    expect(store.getCallsForSessionKeys([])).toEqual([])

    store.close()
  })

  it('loads keyed sessions with keyed reads, honoring the provider', () => {
    const store = makeStore()
    portScopedFixtures(store)

    const sourceByFile = new Map(store.getSources().map(s => [s.filePath, s.id]))
    const claudeNew = sourceByFile.get('/cache/claude/new.jsonl')
    const opencodeOther = sourceByFile.get('/cache/opencode/other.jsonl')
    if (claudeNew === undefined || opencodeOther === undefined) {
      throw new Error('test invariant violated: expected scoped fixture sources')
    }
    const keys = [
      { sourceId: opencodeOther, sessionId: 'sess-other' },
      { sourceId: claudeNew, sessionId: 'sess-new' },
    ]

    expect(store.getSessionsForKeys(keys).map(s => s.sessionId)).toEqual(['sess-new', 'sess-other'])
    expect(store.getSessionsForKeys(keys, 'claude').map(s => s.sessionId)).toEqual(['sess-new'])
    expect(store.getSessionsForKeys(keys, 'nope')).toEqual([])
    expect(store.getSessionsForKeys([])).toEqual([])

    store.close()
  })

  it('the range-filtered call scan uses an index (no full-table scan)', () => {
    const store = makeStore()
    portScopedFixtures(store)

    const plan = store.explainQueryPlan(
      'SELECT source_id, session_id FROM ledger_call WHERE timestamp >= ? AND timestamp <= ?',
      ['2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z'],
    )
    const details = plan.map(row => String(row['detail'] ?? ''))
    expect(
      details.some(
        d => d.includes('idx_ledger_call_timestamp') || d.includes('USING INDEX') || d.includes('USING COVERING INDEX'),
      ),
    ).toBe(true)
    expect(details.some(d => d.includes('SCAN ledger_call'))).toBe(false)

    store.close()
  })
})

describe('DDL-Zod parity: table and column shape (#97)', () => {
  // The ledger's database shape is defined twice by hand: the DDL in
  // LedgerStore and the validation schemas in shared/schemas/ledger. This
  // gate locks the two together at the observable seam — a temporary store's
  // live shape read back through a direct read-only handle — so any column
  // added, renamed, retyped, or re-defaulted fails naming the table+column.
  // No production code changes: pure introspection (PRAGMA table_xinfo),
  // never text snapshots, so harmless SQL reformatting stays green.
  type ExpectedColumn = {
    name: string
    type: string
    dflt: string | null
    nullable: boolean
    hidden: number
    pk: number
  }

  const EXPECTED_TABLES = [
    'currency_rate',
    'display_currency_config',
    'ledger_call',
    'ledger_mcp_config',
    'ledger_session',
    'ledger_source',
    'ledger_turn',
    'model_alias',
    'price_override',
    'refresh_cadence_config',
    'skills_dismissal_config',
  ]

  const EXPECTED_COLUMNS: Record<string, ExpectedColumn[]> = {
    ledger_source: [
      { name: 'id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'provider', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'env_fingerprint', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'file_path', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'repo_url', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'project', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      // Stored as INTEGER but read back as digit-exact TEXT via CAST (NTFS
      // identifiers exceed 2^53): the schemas expect strings, the DDL keeps
      // integers. The parity contract is the column presence + INTEGER type.
      { name: 'fingerprint_dev', type: 'INTEGER', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'fingerprint_ino', type: 'INTEGER', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'fingerprint_mtime_ms', type: 'REAL', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'fingerprint_size_bytes', type: 'INTEGER', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'last_ported_at', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
    ],
    ledger_call: [
      { name: 'source_id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'session_id', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'turn_index', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'call_index', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'dedup_key', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'provider', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'model', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'timestamp', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'speed', type: 'TEXT', dflt: "'standard'", nullable: false, hidden: 0, pk: 0 },
      { name: 'project', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'project_path', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'working_directory', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'base_cost_usd', type: 'REAL', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'is_estimated', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'savings_usd', type: 'REAL', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'savings_baseline_model', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'input_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'output_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'cache_creation_input_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'cache_read_input_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'cached_input_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'reasoning_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'web_search_requests', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'cache_creation_one_hour_tokens', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'agent_type', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'tools_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'mcp_tools_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'skills_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'subagent_types_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'bash_commands_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'tool_sequence_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'loc_added', type: 'INTEGER', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'loc_removed', type: 'INTEGER', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'interrupted', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'user_modified', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'tool_errors', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'edit_failed', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      // Generated STORED idempotency key: introspection reports notnull 0, so
      // the nullability rule sees it as nullable — but it is always populated
      // (COALESCE). The lock here is presence + TEXT type + hidden flag; the
      // expression + uniqueness coverage belong to the #98 constraint gate.
      { name: 'call_key', type: 'TEXT', dflt: null, nullable: true, hidden: 3, pk: 0 },
    ],
    ledger_mcp_config: [
      { name: 'id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'startup_mode', type: 'TEXT', dflt: "'on-demand'", nullable: false, hidden: 0, pk: 0 },
    ],
    ledger_turn: [
      { name: 'source_id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'session_id', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 2 },
      { name: 'turn_index', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 3 },
      { name: 'timestamp', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'user_message', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'git_branch', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'pr_refs_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'spawn_tool_use_ids_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'category', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'sub_category', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'retries', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'has_edits', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
    ],
    ledger_session: [
      { name: 'source_id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'session_id', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 2 },
      { name: 'project', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'project_path', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'working_directory', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'canonical_project', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'canonical_cwd', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'agent_type', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'title', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'pr_links_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'is_sidechain', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
      { name: 'parent_session_id', type: 'TEXT', dflt: null, nullable: true, hidden: 0, pk: 0 },
      { name: 'agent_spawn_links_json', type: 'TEXT', dflt: "'{}'", nullable: false, hidden: 0, pk: 0 },
      { name: 'mcp_inventory_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'ambiguous_spawn_agent_ids_json', type: 'TEXT', dflt: "'[]'", nullable: false, hidden: 0, pk: 0 },
      { name: 'ever_had_branch', type: 'INTEGER', dflt: '0', nullable: false, hidden: 0, pk: 0 },
    ],
    model_alias: [
      { name: 'model', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'alias_of', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
    ],
    price_override: [
      { name: 'model', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'input_price_per_million', type: 'REAL', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'output_price_per_million', type: 'REAL', dflt: null, nullable: false, hidden: 0, pk: 0 },
    ],
    currency_rate: [
      { name: 'code', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'symbol', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'rate', type: 'REAL', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'updated_at', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
    ],
    refresh_cadence_config: [
      { name: 'id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'value', type: 'TEXT', dflt: "'1m'", nullable: false, hidden: 0, pk: 0 },
    ],
    display_currency_config: [
      { name: 'id', type: 'INTEGER', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'code', type: 'TEXT', dflt: "'USD'", nullable: false, hidden: 0, pk: 0 },
    ],
    skills_dismissal_config: [
      { name: 'source', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 1 },
      { name: 'name', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 2 },
      { name: 'reason', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
      { name: 'created', type: 'TEXT', dflt: null, nullable: false, hidden: 0, pk: 0 },
    ],
  }

  type XinfoRow = {
    cid: number
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
    hidden: number
  }

  function readTableNames(ro: DatabaseSync): string[] {
    const rows = ro
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all() as Array<{ name: string }>
    return rows.map(r => r.name)
  }

  function readColumns(ro: DatabaseSync, table: string): XinfoRow[] {
    // Quote the identifier: table names are a fixed allow-list above.
    return ro.prepare(`PRAGMA table_xinfo("${table}")`).all() as XinfoRow[]
  }

  it('locks the eleven-table set (four ledger + seven config)', () => {
    withTempLedgerReadOnly(ro => {
      expect(readTableNames(ro), 'ledger tables').toEqual(EXPECTED_TABLES)
    })
  })

  it('locks every table column: name, exact type, literal default, nullability, hidden flag', () => {
    withTempLedgerReadOnly(ro => {
      for (const table of EXPECTED_TABLES) {
        const actual = readColumns(ro, table)
        const expected = EXPECTED_COLUMNS[table]
        if (expected === undefined) throw new Error(`test invariant violated: expected columns for table ${table}`)
        expect(
          actual.map(c => c.name),
          `[${table}] column names`,
        ).toEqual(expected.map(c => c.name))
        for (const exp of expected) {
          const col = actual.find(c => c.name === exp.name)
          expect(col, `[${table}.${exp.name}] present`).toBeDefined()
          if (!col) continue
          expect(col.type, `[${table}.${exp.name}] type`).toBe(exp.type)
          // Literal-aware defaults: quoted text stays quoted ('[]' !== []),
          // numeric defaults arrive as their literal text ('0').
          expect(col.dflt_value, `[${table}.${exp.name}] default`).toBe(exp.dflt)
          // The engine reports PK columns as nullable unless explicitly
          // constrained, so a PK counts as NOT NULL by position alone.
          const effectivelyNotNull = col.notnull === 1 || col.pk > 0
          expect(effectivelyNotNull, `[${table}.${exp.name}] nullability`).toBe(!exp.nullable)
          expect(col.hidden, `[${table}.${exp.name}] hidden`).toBe(exp.hidden)
          expect(col.pk, `[${table}.${exp.name}] pk order`).toBe(exp.pk)
        }
      }
    })
  })

  it('locks composite primary-key order positionally', () => {
    withTempLedgerReadOnly(ro => {
      function pkOrder(table: string): string[] {
        return readColumns(ro, table)
          .filter(c => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map(c => c.name)
      }
      expect(pkOrder('ledger_turn'), '[ledger_turn] pk order').toEqual(['source_id', 'session_id', 'turn_index'])
      expect(pkOrder('ledger_session'), '[ledger_session] pk order').toEqual(['source_id', 'session_id'])
      expect(pkOrder('skills_dismissal_config'), '[skills_dismissal_config] pk order').toEqual(['source', 'name'])
      expect(pkOrder('ledger_source'), '[ledger_source] pk order').toEqual(['id'])
    })
  })

  it('locks the Zod row schemas to the column catalog (schema-only drift fails)', () => {
    // The shape gate above locks live DDL against EXPECTED_COLUMNS. This
    // locks EXPECTED_COLUMNS against the Zod input shapes, so a column added
    // or renamed on either side alone turns red. JSON helper coverage (S8) is
    // locked the same way: every `*_json` DDL column must be a JSON-parsing
    // pipe in Zod, and vice versa. Behavioural proof plus the per-column
    // exercise forcing live in #99.
    const linked = {
      ledger_source: ledgerSourceRowSchema,
      ledger_session: ledgerSessionRowSchema,
      ledger_turn: ledgerTurnRowSchema,
      ledger_call: ledgerCallRowSchema,
      model_alias: modelAliasRowSchema,
      price_override: priceOverrideRowSchema,
      currency_rate: currencyRateRowSchema,
    }
    for (const [table, schema] of Object.entries(linked)) {
      const expectedColumns = EXPECTED_COLUMNS[table]
      if (expectedColumns === undefined) throw new Error(`test invariant violated: expected columns for table ${table}`)
      const dbColumns = expectedColumns.map(c => c.name).sort()
      expect(zodInputKeys(schema), `[${table}] Zod input keys match DDL columns`).toEqual(dbColumns)
      const dbJson = dbColumns.filter(name => name.endsWith('_json'))
      expect(zodJsonKeys(schema), `[${table}] JSON columns use JSON helpers`).toEqual(dbJson)
    }
    // refresh_cadence_config, display_currency_config, ledger_mcp_config and
    // skills_dismissal_config have no Zod row schemas (scalar reads); the
    // shape gate above owns them.
  })
})

describe('DDL-Zod parity: indexes and constraints (#98)', () => {
  // The constraint gate: performance indexes, uniqueness and primary-key
  // coverage, plus the spots introspection cannot see. Named (`origin = 'c'`)
  // indexes are distinguished from implicit constraint auto-indexes
  // (`origin = 'u'`/`'pk'`); full-definition text is used ONLY where
  // introspection is blind (generated-column expression, singleton CHECKs).
  // Test-only, same seam as #97: temp store + direct read-only handle.
  type IndexListRow = {
    seq: number
    name: string
    unique: number
    origin: string
    partial: number
  }

  type IndexXinfoRow = {
    seqno: number
    cid: number
    name: string | null
    key: number
  }

  const EXPECTED_NAMED_CALL_INDEXES: Record<string, string[]> = {
    idx_ledger_call_timestamp: ['timestamp'],
    idx_ledger_call_session: ['session_id'],
    idx_ledger_call_model: ['model'],
    idx_ledger_call_project: ['project'],
    idx_ledger_call_provider: ['provider'],
    // Query-scaling (#139): the scoped reads filter on these composites.
    idx_ledger_call_provider_timestamp: ['provider', 'timestamp'],
    idx_ledger_call_source_timestamp: ['source_id', 'timestamp'],
  }

  const EXPECTED_NAMED_TURN_INDEXES: Record<string, string[]> = {
    idx_ledger_turn_timestamp: ['timestamp'],
    idx_ledger_turn_source_timestamp: ['source_id', 'timestamp'],
  }

  const EXPECTED_IMPLICIT: Record<string, Array<{ origin: string; columns: string[] }>> = {
    ledger_call: [{ origin: 'u', columns: ['source_id', 'session_id', 'call_key'] }],
    ledger_source: [{ origin: 'u', columns: ['provider', 'env_fingerprint', 'file_path'] }],
    ledger_session: [{ origin: 'pk', columns: ['source_id', 'session_id'] }],
    ledger_turn: [{ origin: 'pk', columns: ['source_id', 'session_id', 'turn_index'] }],
    model_alias: [{ origin: 'pk', columns: ['model'] }],
    price_override: [{ origin: 'pk', columns: ['model'] }],
    currency_rate: [{ origin: 'pk', columns: ['code'] }],
    skills_dismissal_config: [{ origin: 'pk', columns: ['source', 'name'] }],
  }

  // INTEGER PRIMARY KEY is a rowid alias: no separate index entry exists.
  // PK position itself is locked by the #97 column gate; here we lock the
  // absence of an auto-index plus the singleton CHECK via definition text.
  const ROWID_PK_TABLES = ['refresh_cadence_config', 'display_currency_config', 'ledger_mcp_config']

  function readIndexList(ro: DatabaseSync, table: string): IndexListRow[] {
    return ro.prepare(`PRAGMA index_list("${table}")`).all() as IndexListRow[]
  }

  function readIndexColumns(ro: DatabaseSync, index: string): string[] {
    const rows = ro.prepare(`PRAGMA index_xinfo("${index}")`).all() as IndexXinfoRow[]
    return rows
      .filter(r => r.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      .map(r => {
        if (r.name === null) throw new Error('test invariant violated: expected an index column name')
        return r.name
      })
  }

  function readTableSql(ro: DatabaseSync, table: string): string {
    const row = ro.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      { sql: string | null } | undefined
    return row?.sql ?? ''
  }

  it('locks the named call-table indexes with their exact columns', () => {
    withTempLedgerReadOnly(ro => {
      const list = readIndexList(ro, 'ledger_call')
      const named = list.filter(i => i.origin === 'c')
      expect(named.map(i => i.name).sort(), '[ledger_call] named indexes').toEqual(
        Object.keys(EXPECTED_NAMED_CALL_INDEXES).sort(),
      )
      for (const [index, columns] of Object.entries(EXPECTED_NAMED_CALL_INDEXES)) {
        const entry = named.find(i => i.name === index)
        expect(entry, `[ledger_call.${index}] present`).toBeDefined()
        if (!entry) continue
        expect(entry.origin, `[ledger_call.${index}] origin`).toBe('c')
        expect(entry.unique, `[ledger_call.${index}] unique`).toBe(0)
        expect(readIndexColumns(ro, index), `[ledger_call.${index}] columns`).toEqual(columns)
      }
    })
  })

  it('locks the named turn-table indexes for the scoped reads', () => {
    withTempLedgerReadOnly(ro => {
      const list = readIndexList(ro, 'ledger_turn')
      const named = list.filter(i => i.origin === 'c')
      expect(named.map(i => i.name).sort(), '[ledger_turn] named indexes').toEqual(
        Object.keys(EXPECTED_NAMED_TURN_INDEXES).sort(),
      )
      for (const [index, columns] of Object.entries(EXPECTED_NAMED_TURN_INDEXES)) {
        const entry = named.find(i => i.name === index)
        expect(entry, `[ledger_turn.${index}] present`).toBeDefined()
        if (!entry) continue
        expect(entry.origin, `[ledger_turn.${index}] origin`).toBe('c')
        expect(entry.unique, `[ledger_turn.${index}] unique`).toBe(0)
        expect(readIndexColumns(ro, index), `[ledger_turn.${index}] columns`).toEqual(columns)
      }
    })
  })

  it('locks implicit primary-key and uniqueness coverage, including the generated-column span', () => {
    withTempLedgerReadOnly(ro => {
      for (const [table, expected] of Object.entries(EXPECTED_IMPLICIT)) {
        const implicit = readIndexList(ro, table).filter(i => i.origin !== 'c')
        const actual = implicit.map(i => ({
          origin: i.origin,
          columns: readIndexColumns(ro, i.name),
        }))
        expect(actual, `[${table}] implicit indexes`).toEqual(expected)
        for (const entry of implicit) {
          expect(entry.unique, `[${table}.${entry.name}] unique`).toBe(1)
        }
      }
      // The idempotency guarantee is database-enforced: the call uniqueness
      // spans the generated call_key (COALESCE over dedup_key).
      const callUnique = readIndexList(ro, 'ledger_call').find(i => i.origin === 'u')
      if (callUnique === undefined) throw new Error('test invariant violated: expected a unique index on ledger_call')
      expect(
        readIndexColumns(ro, callUnique.name),
        '[ledger_call.UNIQUE(source_id, session_id, call_key)] columns',
      ).toEqual(['source_id', 'session_id', 'call_key'])
      for (const table of ROWID_PK_TABLES) {
        expect(readIndexList(ro, table), `[${table}] no separate index (rowid PK)`).toEqual([])
      }
    })
  })

  it('spot-checks definition text only where introspection is blind', () => {
    withTempLedgerReadOnly(ro => {
      const callSql = readTableSql(ro, 'ledger_call')
      expect(callSql, '[ledger_call.call_key] generated marker').toContain('GENERATED ALWAYS AS')
      expect(callSql, '[ledger_call.call_key] generated expression').toContain(
        "COALESCE(dedup_key, printf('%d:%d', turn_index, call_index))",
      )
      expect(callSql, '[ledger_call.call_key] stored marker').toContain('STORED')
      for (const table of ROWID_PK_TABLES) {
        expect(readTableSql(ro, table), `[${table}] singleton-row check`).toContain('CHECK (id = 1)')
      }
    })
  })
})

describe('DDL-Zod parity: adversarial round-trip (#99)', () => {
  // The behavioral proof for what shape assertions cannot see: one fixture
  // ports non-default payloads through every `*_json` column, exercises
  // nullable columns both empty and set plus both speed values, and asserts
  // the API-shaped (snake_case→camelCase, digit-exact fingerprint strings,
  // null→undefined source shaping) read-back deep-equal to the input mapping
  // — so a broken data-format helper, name remapping, or default-shaping rule
  // fails on the wire contract, not silently. Call/session INTEGER and NULL
  // passthrough is asserted exactly as the schemas define it.
  // Test-only, same seam: temp store port-in → typed getters.
  it('round-trips adversarial payloads through every JSON column with exact API shaping', () => {
    const store = makeStore()
    try {
      const file = buildFixtureCachedFile({
        title: 'Parity adversarial round trip',
        agentType: 'parity-harness',
        workingDirectory: '/workspace/demo-project',
        mcpInventory: ['parity-mcp-server'],
        agentSpawnLinks: { 'spawn-parity-1': 'sess-side-parity' },
        ambiguousSpawnAgentIds: ['spawn-ambiguous-parity'],
        prLinks: ['https://github.com/acme/demo-project/pull/8'],
        isSidechain: true,
        parentSessionId: 'sess-parent-parity',
      })
      file.turns[0] = {
        ...buildFixtureCachedTurn(0, 'Refactor the auth module'),
        prRefs: ['https://github.com/acme/demo-project/pull/7'],
        spawnToolUseIds: ['tooluse-parity-1'],
        calls: [
          {
            ...buildFixtureCachedCall(0),
            tools: ['Edit', 'Bash', 'mcp__parity__query'],
            bashCommands: ['npm run parity', 'git status --porcelain'],
            skills: ['parity-skill'],
            subagentTypes: ['parity-subagent'],
            toolSequence: [
              [
                { tool: 'Edit', file: 'src/parity.ts' },
                { tool: 'Bash', command: 'npm run parity' },
              ],
              [{ tool: 'Read', file: 'src/parity.ts' }],
            ],
            usage: {
              inputTokens: 111,
              outputTokens: 22,
              cacheCreationInputTokens: 33,
              cacheReadInputTokens: 44,
              cachedInputTokens: 55,
              reasoningTokens: 66,
              webSearchRequests: 7,
              cacheCreationOneHourTokens: 8,
            },
            costUSD: 1.23,
            isEstimated: true,
            locAdded: 12,
            locRemoved: 3,
            interrupted: true,
            toolErrors: 2,
            editFailed: 1,
          },
        ],
      }
      file.turns.push({
        ...buildFixtureCachedTurn(1, 'Add the new endpoint'),
        gitBranch: 'parity/branch',
        calls: [
          {
            ...buildFixtureCachedCall(1),
            speed: 'fast',
            workingDirectory: '/tmp/parity-other',
            costUSD: 0.07,
          },
        ],
      })

      const result = store.portIn({ ...baseInput, verdict: 'new', cachedFile: file, project: 'demo-project' })
      expect(result.inserted).toEqual({ sessions: 1, turns: 2, calls: 2 })

      const firstSource = store.getSources()[0]
      if (firstSource === undefined) throw new Error('test invariant violated: expected a source')
      const sourceId = firstSource.id
      expect(store.getSources()).toMatchObject([
        {
          provider: 'opencode',
          envFingerprint: 'env-demo',
          filePath: FIXTURE_SOURCE_PATH,
          repoUrl: 'https://github.com/acme/demo-project',
          project: 'demo-project',
          fingerprint: { dev: '42', ino: '4242', mtimeMs: 1_751_300_000_000, sizeBytes: 4096 },
          lastPortedAt: expect.any(String),
        },
      ])

      // Session: all four JSON columns non-default, nullable set, remapped.
      expect(store.getSessions()).toEqual([
        {
          sourceId,
          sessionId: 'sess-0',
          project: 'demo-project',
          projectPath: '/workspace/demo-project',
          workingDirectory: '/workspace/demo-project',
          canonicalProject: 'demo-project',
          canonicalCwd: '/workspace/demo-project',
          agentType: 'parity-harness',
          title: 'Parity adversarial round trip',
          prLinks: ['https://github.com/acme/demo-project/pull/7', 'https://github.com/acme/demo-project/pull/8'],
          isSidechain: 1,
          parentSessionId: 'sess-parent-parity',
          agentSpawnLinks: { 'spawn-parity-1': 'sess-side-parity' },
          mcpInventory: ['parity-mcp-server'],
          ambiguousSpawnAgentIds: ['spawn-ambiguous-parity'],
          everHadBranch: 1,
        },
      ])

      // Turns: nullable git_branch/pr_refs/spawn ids empty on turn 0 side and
      // set on turn 1 side (branch carry-forward needs the null first).
      const turns = store.getTurns()
      expect(turns).toHaveLength(2)
      expect(turns[0]).toEqual({
        sourceId,
        sessionId: 'sess-0',
        turnIndex: 0,
        timestamp: '2026-07-01T09:00:00.000Z',
        userMessage: 'Refactor the auth module',
        gitBranch: null,
        prRefs: ['https://github.com/acme/demo-project/pull/7'],
        spawnToolUseIds: ['tooluse-parity-1'],
        category: 'refactoring',
        // The classifier derives the turn's sub-category from the invoked
        // skill: the parity skill invocation above reclassifies the turn.
        subCategory: 'parity-skill',
        retries: 0,
        hasEdits: 1,
      })
      expect(turns[1]).toEqual({
        sourceId,
        sessionId: 'sess-0',
        turnIndex: 1,
        timestamp: '2026-07-01T09:11:00.000Z',
        userMessage: 'Add the new endpoint',
        gitBranch: 'parity/branch',
        prRefs: [],
        spawnToolUseIds: [],
        category: 'feature',
        subCategory: null,
        retries: 0,
        hasEdits: 1,
      })

      // Calls: all six JSON columns non-default on call 0, default-shaped on
      // call 1; both speeds; nullable loc set/null; remapped + shaped.
      const calls = store.getCalls()
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual({
        sourceId,
        sessionId: 'sess-0',
        turnIndex: 0,
        callIndex: 0,
        callKey: 'call-1',
        dedupKey: 'call-1',
        provider: 'opencode',
        model: 'demo-model',
        timestamp: '2026-07-01T09:00:00.000Z',
        speed: 'standard',
        project: 'demo-project',
        projectPath: '/workspace/demo-project',
        workingDirectory: '/workspace/demo-project',
        baseCostUSD: 1.23,
        isEstimated: 1,
        savingsUSD: 0,
        savingsBaselineModel: null,
        inputTokens: 111,
        outputTokens: 22,
        cacheCreationInputTokens: 33,
        cacheReadInputTokens: 44,
        cachedInputTokens: 55,
        reasoningTokens: 66,
        webSearchRequests: 7,
        cacheCreationOneHourTokens: 8,
        agentType: 'parity-harness',
        tools: ['Edit', 'Bash', 'mcp__parity__query'],
        mcpTools: ['mcp__parity__query'],
        skills: ['parity-skill'],
        subagentTypes: ['parity-subagent'],
        bashCommands: ['npm run parity', 'git status --porcelain'],
        toolSequence: [
          [
            { tool: 'Edit', file: 'src/parity.ts' },
            { tool: 'Bash', command: 'npm run parity' },
          ],
          [{ tool: 'Read', file: 'src/parity.ts' }],
        ],
        locAdded: 12,
        locRemoved: 3,
        interrupted: 1,
        userModified: 0,
        toolErrors: 2,
        editFailed: 1,
      })
      expect(calls[1]).toEqual({
        sourceId,
        sessionId: 'sess-0',
        turnIndex: 1,
        callIndex: 0,
        callKey: 'call-2',
        dedupKey: 'call-2',
        provider: 'opencode',
        model: 'demo-model',
        timestamp: '2026-07-01T09:11:00.000Z',
        speed: 'fast',
        project: 'demo-project',
        projectPath: '/workspace/demo-project',
        workingDirectory: '/tmp/parity-other',
        agentType: 'parity-harness',
        baseCostUSD: 0.07,
        isEstimated: 0,
        savingsUSD: 0,
        savingsBaselineModel: null,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20,
        cachedInputTokens: 0,
        reasoningTokens: 5,
        webSearchRequests: 0,
        cacheCreationOneHourTokens: 0,
        tools: ['Edit'],
        mcpTools: [],
        skills: [],
        subagentTypes: [],
        bashCommands: [],
        toolSequence: [],
        locAdded: null,
        locRemoved: null,
        interrupted: 0,
        userModified: 0,
        toolErrors: 0,
        editFailed: 0,
      })

      // S8 forcing: every `*_json` column derived from the Zod shapes must
      // carry a non-default payload in this fixture — a future JSON column
      // wired through DDL + schemas but never exercised here fails naming
      // the table+column instead of shipping unproven.
      const jsonTables = {
        ledger_session: ledgerSessionRowSchema,
        ledger_turn: ledgerTurnRowSchema,
        ledger_call: ledgerCallRowSchema,
      }
      const probe = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        for (const [table, schema] of Object.entries(jsonTables)) {
          for (const column of zodJsonKeys(schema)) {
            // Identifiers come from the fixed table map above plus Zod shape
            // keys — never from fixture input.
            const values = probe.prepare(`SELECT "${column}" AS v FROM "${table}"`).all() as Array<{ v: string }>
            expect(values.length, `[${table}.${column}] rows probed`).toBeGreaterThan(0)
            expect(
              values.some(r => jsonIsNonEmpty(r.v)),
              `[${table}.${column}] non-default JSON payload ported`,
            ).toBe(true)
          }
        }
      } finally {
        probe.close()
      }

      // Null→undefined shaping: a source ported without discovery metadata
      // (no repoUrl/project) reads its nullable columns back shaped to
      // undefined — never null — so a broken default-shaping rule fails here.
      store.portIn({
        provider: 'opencode',
        envFingerprint: 'env-demo',
        filePath: '/Users/demo/.local/share/opencode/demo-project/sess-unshaped.jsonl',
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      const unshaped = store.getSources().find(s => s.filePath.endsWith('sess-unshaped.jsonl'))
      if (unshaped === undefined) throw new Error('test invariant violated: expected an unshaped source')
      expect(unshaped.repoUrl).toBeUndefined()
      expect(unshaped.project).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

describe('DDL-Zod parity: targeted edge tests (#100)', () => {
  // What neither the shape gates (#97/#98) nor the round trip (#99) reach:
  // platform identifier precision, enum closedness, and read-query column
  // coverage. Test-only, same seams as the file's existing tests.
  it('reads fingerprint identifiers back as digit-exact strings, never arithmetized', () => {
    // Companion to the existing oversized-identifier test (which proves reads
    // beyond 2^53 never throw): this locks the TEXT contract itself — even
    // small identifiers come back as strings, while mtime/size stay numeric —
    // and re-anchors one oversized round trip so this gate owns the criterion
    // directly instead of by reference.
    const store = makeStore()
    try {
      store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
      const sources = store.getSources()
      expect(sources).toHaveLength(1)
      expect(typeof sources[0]?.fingerprint.dev).toBe('string')
      expect(typeof sources[0]?.fingerprint.ino).toBe('string')
      expect(sources[0]?.fingerprint).toEqual({
        dev: '42',
        ino: '4242',
        mtimeMs: 1_751_300_000_000,
        sizeBytes: 4096,
      })

      const oversized = buildFixtureCachedFile()
      oversized.fingerprint = { dev: 2 ** 53, ino: 2 ** 53 + 100, mtimeMs: 1_751_300_000_000, sizeBytes: 4096 }
      store.portIn({
        ...baseInput,
        filePath: '/Users/demo/.local/share/opencode/demo-project/sess-oversized.jsonl',
        verdict: 'new',
        cachedFile: oversized,
      })
      const anchor = store.getSources().find(s => s.filePath.endsWith('sess-oversized.jsonl'))
      if (anchor === undefined) throw new Error('test invariant violated: expected an oversized source')
      expect(anchor.fingerprint.dev).toBe(String(2 ** 53))
      expect(anchor.fingerprint.ino).toBe(String(2 ** 53 + 100))
    } finally {
      store.close()
    }
  })

  it('rejects an unknown speed value at the schema boundary', () => {
    // The database cannot anchor the enum (speed is plain TEXT with a
    // 'standard' default and no CHECK), so the schema is the only closed
    // gate: a value smuggled past port-in must fail the read-back parse.
    // Public surface only: seed through the store, close it, smuggle the
    // value through a plain database handle, and read back with a fresh
    // store — no production internals touched.
    const seeding = makeStore()
    seeding.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    const dbPath = seeding.dbPath
    seeding.close()
    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    } finally {
      writer.close()
    }
    const reopened = new LedgerStore(dbPath)
    try {
      expect(() => reopened.getCalls()).toThrow(/speed/i)
    } finally {
      reopened.close()
    }
  })

  it('covers every mapped field in the read-back queries (no forgotten column)', () => {
    // A read query that forgets a column still parses whenever the schema
    // field is optional — so port a fully-populated fixture and assert every
    // read-back field: exact values (a forgotten column reads back as its
    // default/undefined instead of the populated value) plus a recursive
    // undefined scan that names the path. Any dropped selected column fails
    // one of the two with its field named.
    const store = makeStore()
    try {
      const file = buildFixtureCachedFile({
        title: 'Coverage probe',
        agentType: 'coverage-harness',
        workingDirectory: '/wrk/coverage',
        mcpInventory: ['cov-mcp'],
        agentSpawnLinks: { 'spawn-cov-1': 'sess-cov-side' },
        ambiguousSpawnAgentIds: ['spawn-ambiguous-cov'],
        prLinks: ['https://github.com/acme/demo-project/pull/9'],
        isSidechain: true,
        parentSessionId: 'sess-parent-cov',
      })
      file.turns[0] = {
        ...buildFixtureCachedTurn(0, 'Add the new endpoint'),
        gitBranch: 'coverage/branch',
        prRefs: ['https://github.com/acme/demo-project/pull/10'],
        spawnToolUseIds: ['tooluse-cov-1'],
        calls: [
          {
            ...buildFixtureCachedCall(0),
            tools: ['Edit', 'mcp__cov__tool'],
            bashCommands: ['make coverage'],
            skills: ['cov-skill'],
            subagentTypes: ['cov-subagent'],
            toolSequence: [[{ tool: 'Edit', file: 'src/cov.ts' }]],
            usage: {
              inputTokens: 7,
              outputTokens: 8,
              cacheCreationInputTokens: 9,
              cacheReadInputTokens: 10,
              cachedInputTokens: 11,
              reasoningTokens: 12,
              webSearchRequests: 1,
              cacheCreationOneHourTokens: 2,
            },
            costUSD: 2.5,
            isEstimated: true,
            locAdded: 1,
            locRemoved: 2,
            interrupted: true,
            userModified: true,
            toolErrors: 3,
            editFailed: 4,
          },
        ],
      }
      store.portIn({ ...baseInput, verdict: 'new', cachedFile: file, project: 'demo-project' })

      const firstSource = store.getSources()[0]
      if (firstSource === undefined) throw new Error('test invariant violated: expected a source')
      const sourceId = firstSource.id
      expect(store.getSources()).toMatchObject([
        {
          id: expect.any(Number),
          provider: 'opencode',
          envFingerprint: 'env-demo',
          filePath: FIXTURE_SOURCE_PATH,
          repoUrl: 'https://github.com/acme/demo-project',
          project: 'demo-project',
          fingerprint: { dev: '42', ino: '4242', mtimeMs: 1_751_300_000_000, sizeBytes: 4096 },
          lastPortedAt: expect.any(String),
        },
      ])
      expect(store.getSessions()).toEqual([
        {
          sourceId,
          sessionId: 'sess-0',
          project: 'demo-project',
          projectPath: '/workspace/demo-project',
          workingDirectory: '/wrk/coverage',
          canonicalProject: 'demo-project',
          canonicalCwd: '/workspace/demo-project',
          agentType: 'coverage-harness',
          title: 'Coverage probe',
          prLinks: ['https://github.com/acme/demo-project/pull/10', 'https://github.com/acme/demo-project/pull/9'],
          isSidechain: 1,
          parentSessionId: 'sess-parent-cov',
          agentSpawnLinks: { 'spawn-cov-1': 'sess-cov-side' },
          mcpInventory: ['cov-mcp'],
          ambiguousSpawnAgentIds: ['spawn-ambiguous-cov'],
          everHadBranch: 1,
        },
      ])
      expect(store.getTurns()).toEqual([
        {
          sourceId,
          sessionId: 'sess-0',
          turnIndex: 0,
          timestamp: '2026-07-01T09:00:00.000Z',
          userMessage: 'Add the new endpoint',
          gitBranch: 'coverage/branch',
          prRefs: ['https://github.com/acme/demo-project/pull/10'],
          spawnToolUseIds: ['tooluse-cov-1'],
          category: 'feature',
          subCategory: 'cov-skill',
          retries: 0,
          hasEdits: 1,
        },
      ])
      expect(store.getCalls()).toEqual([
        {
          sourceId,
          sessionId: 'sess-0',
          turnIndex: 0,
          callIndex: 0,
          callKey: 'call-1',
          dedupKey: 'call-1',
          provider: 'opencode',
          model: 'demo-model',
          timestamp: '2026-07-01T09:00:00.000Z',
          speed: 'standard',
          project: 'demo-project',
          projectPath: '/workspace/demo-project',
          workingDirectory: '/wrk/coverage',
          baseCostUSD: 2.5,
          isEstimated: 1,
          savingsUSD: 0,
          savingsBaselineModel: null,
          inputTokens: 7,
          outputTokens: 8,
          cacheCreationInputTokens: 9,
          cacheReadInputTokens: 10,
          cachedInputTokens: 11,
          reasoningTokens: 12,
          webSearchRequests: 1,
          cacheCreationOneHourTokens: 2,
          agentType: 'coverage-harness',
          tools: ['Edit', 'mcp__cov__tool'],
          mcpTools: ['mcp__cov__tool'],
          skills: ['cov-skill'],
          subagentTypes: ['cov-subagent'],
          bashCommands: ['make coverage'],
          toolSequence: [[{ tool: 'Edit', file: 'src/cov.ts' }]],
          locAdded: 1,
          locRemoved: 2,
          interrupted: 1,
          userModified: 1,
          toolErrors: 3,
          editFailed: 4,
        },
      ])

      function undefinedPaths(value: unknown, prefix = ''): string[] {
        if (typeof value !== 'object' || value === null) return []
        if (Array.isArray(value)) {
          return value.flatMap((item, i) => undefinedPaths(item, `${prefix}[${i}]`))
        }
        const out: string[] = []
        for (const [key, nested] of Object.entries(value)) {
          if (nested === undefined) out.push(prefix + key)
          else out.push(...undefinedPaths(nested, `${prefix}${key}.`))
        }
        return out
      }
      const tables = {
        source: store.getSources(),
        session: store.getSessions(),
        turn: store.getTurns(),
        call: store.getCalls(),
      } as const
      for (const [table, rows] of Object.entries(tables)) {
        expect(rows.length, `[${table}] rows read back`).toBeGreaterThan(0)
        for (const row of rows) {
          expect(undefinedPaths(row), `[${table}] fully-populated row has no undefined fields`).toEqual([])
        }
      }
    } finally {
      store.close()
    }
  })
})
