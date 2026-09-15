import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // temp dirs are left to the OS; only the store handle is closed by tests
  }
})

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: FIXTURE_SOURCE_PATH,
  repoUrl: 'https://github.com/acme/demo-project',
}

describe('LedgerStore (the store seam: port-in → read back)', () => {
  it('opens green field: four ledger tables + five call indexes, no report/metrics tables', () => {
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
    expect(indexes.sort()).toEqual([
      'idx_ledger_call_timestamp',
      'idx_ledger_call_session',
      'idx_ledger_call_model',
      'idx_ledger_call_project',
      'idx_ledger_call_provider',
    ].sort())

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
    const call = modified.turns[0]!.calls[0]!
    call.costUSD = 0.99
    call.usage = { ...call.usage, inputTokens: 500 }
    const result = store.portIn({ ...baseInput, verdict: 'modified', cachedFile: modified })

    expect(result.inserted).toEqual({ sessions: 1, turns: 1, calls: 1 })
    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.baseCostUSD).toBeCloseTo(0.99, 6)
    expect(calls[0]!.inputTokens).toBe(500)

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
    file.turns[0]!.sessionId = '9b702997-3777-4470-8cbb-961e462d9f29'

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
    expect(store.getCalls()[0]!.project).toBe('my-repo')

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
    expect(sources[0]!.fingerprint.dev).toBe(String(2 ** 53))
    expect(sources[0]!.fingerprint.ino).toBe(String(2 ** 53 + 2))
    expect(sources[0]!.fingerprint.mtimeMs).toBe(1_751_300_000_000)
    expect(sources[0]!.fingerprint.sizeBytes).toBe(4096)

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

  it('repoUrl is captured per source at port-in and read back without a rescan', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    expect(store.getSources()[0]!.repoUrl).toBe('https://github.com/acme/demo-project')

    store.close()
  })

  it('carries the git branch forward and persists classification + PR refs per turn', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    file.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/7']
    file.turns.push({ ...buildFixtureCachedTurn(1, 'Add the new endpoint'), gitBranch: 'feature/auth' })

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const turns = store.getTurns()
    expect(turns).toHaveLength(2)
    expect(turns[0]!.gitBranch).toBeNull()
    expect(turns[1]!.gitBranch).toBe('feature/auth')
    expect(turns[0]!.prRefs).toEqual(['https://github.com/acme/demo-project/pull/7'])
    expect(turns[1]!.category).toBe('feature')
    expect(store.getSessions()[0]!.prLinks).toEqual(['https://github.com/acme/demo-project/pull/7'])
    expect(store.getSessions()[0]!.everHadBranch).toBe(1)

    store.close()
  })

  it('round-trips bash commands per call and ambiguous spawn ids per session', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile({
      ambiguousSpawnAgentIds: ['spawn-ambiguous-1'],
    })
    file.turns[0]!.calls[0]!.bashCommands = ['npm test', 'git status']

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.bashCommands).toEqual(['npm test', 'git status'])

    const sessions = store.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.ambiguousSpawnAgentIds).toEqual(['spawn-ambiguous-1'])

    store.close()
  })

  it('round-trips per-call tool sequence bytes (overview/optimize need it)', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    file.turns[0]!.calls[0]!.toolSequence = [
      [{ tool: 'Edit', file: 'src/auth.ts' }, { tool: 'Bash', command: 'npm test' }],
      [{ tool: 'Read', file: 'src/auth.ts' }],
    ]

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const calls = store.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolSequence).toEqual([
      [{ tool: 'Edit', file: 'src/auth.ts' }, { tool: 'Bash', command: 'npm test' }],
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
    expect(store.getPriceOverrides()).toEqual([{ model: 'demo-model', inputPricePerMillion: 3, outputPricePerMillion: 15 }])
    expect(store.getCurrencyRate('EUR')).toEqual({ code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-07-01T00:00:00.000Z' })
    expect(store.getDisplayCurrency()).toBe('EUR')
    expect(store.getRefreshCadence()).toBe('5m')
    expect(store.getSkillDismissals()).toHaveLength(1)

    // a second upsert overwrites, never appends
    store.setPriceOverride('demo-model', { inputPricePerMillion: 4, outputPricePerMillion: 16 })
    expect(store.getPriceOverrides()).toEqual([{ model: 'demo-model', inputPricePerMillion: 4, outputPricePerMillion: 16 }])

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.clear()

    expect(store.getSources()).toEqual([])
    expect(store.getModelAliases()).toEqual([{ model: 'proxy-model', aliasOf: 'claude-sonnet-4.5' }])
    expect(store.getPriceOverrides()).toEqual([{ model: 'demo-model', inputPricePerMillion: 4, outputPricePerMillion: 16 }])
    expect(store.getCurrencyRate('EUR')).not.toBeNull()
    expect(store.getDisplayCurrency()).toBe('EUR')
    expect(store.getRefreshCadence()).toBe('5m')
    expect(store.getSkillDismissals()).toEqual([{ source: 'bash', name: 'git commit', reason: 'not-a-skill', created: expect.any(String) }])

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
