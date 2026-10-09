import { describe, expect, it } from 'vitest'

import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { searchSessionsFromData } from '../src/main/session-search-calculation.js'
import type { SessionSearchData } from '../src/main/store/session-read-projections.js'

const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})

function emptyData(): SessionSearchData {
  return { sessions: [], turns: [], calls: [], aliases: [] }
}

function addSession(
  data: SessionSearchData,
  sourceId: number,
  sessionId: string,
  timestamp: string,
  userMessage: string,
  commands: string[] = [],
) {
  data.sessions.push({
    sourceId,
    sessionId,
    project: 'legacy-project',
    projectPath: '/workspace/project',
    workingDirectory: '/workspace/project',
    canonicalProject: 'project',
    canonicalCwd: '/workspace/project',
    sourceProvider: 'codex',
  })
  data.turns.push({ sourceId, sessionId, turnIndex: 0, timestamp, userMessage })
  commands.forEach((bashCommand, callIndex) =>
    data.calls.push({
      sourceId,
      sessionId,
      turnIndex: 0,
      callIndex,
      provider: 'codex',
      model: 'gpt-5.4',
      timestamp: `${timestamp.slice(0, 19)}.${String(callIndex + 1).padStart(3, '0')}Z`,
      bashCommands: [bashCommand],
    }),
  )
}

describe('session search calculation', () => {
  it('trims and folds case, checks each message before bash, and returns the first ordered hit', () => {
    const data = emptyData()
    addSession(data, 1, 'search-me', '2026-01-02T00:00:00.000Z', 'Find TARGET in this request', ['run target'])
    addSession(data, 1, 'bash-hit', '2026-01-03T00:00:00.000Z', 'ordinary request', [
      'first target command',
      'second TARGET command',
    ])
    const hits = searchSessionsFromData(data, '  TaRgEt  ', catalogue)
    expect(hits).toEqual([
      {
        sessionId: 'bash-hit',
        project: 'project',
        provider: 'codex',
        timestamp: '2026-01-03T00:00:00.001Z',
        kind: 'bash',
        snippet: 'first target command',
      },
      {
        sessionId: 'search-me',
        project: 'project',
        provider: 'codex',
        timestamp: '2026-01-02T00:00:00.000Z',
        kind: 'message',
        snippet: 'Find TARGET in this request',
      },
    ])
  })

  it('preserves turn/call ordering, skips invalid-first-call turns, and deduplicates public session IDs', () => {
    const data = emptyData()
    addSession(data, 1, 'duplicate', '2026-01-02T00:00:00.000Z', 'older', ['target first'])
    addSession(data, 2, 'duplicate', '2026-01-01T00:00:00.000Z', 'earlier duplicate', ['target duplicate'])
    addSession(data, 3, 'invalid-only', '2026-01-01T00:00:00.000Z', 'target invalid message')
    data.turns.push({
      sourceId: 3,
      sessionId: 'invalid-only',
      turnIndex: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      userMessage: 'target invalid first timestamp',
    })
    data.calls.push({
      sourceId: 3,
      sessionId: 'invalid-only',
      turnIndex: 1,
      callIndex: 0,
      provider: 'codex',
      model: 'gpt-5.4',
      timestamp: 'invalid',
      bashCommands: [],
    })
    data.turns.push(
      {
        sourceId: 1,
        sessionId: 'duplicate',
        turnIndex: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        userMessage: 'target invalid first',
      },
      {
        sourceId: 1,
        sessionId: 'duplicate',
        turnIndex: 2,
        timestamp: '2026-01-01T00:00:00.000Z',
        userMessage: 'target valid turn',
      },
    )
    data.calls.push(
      {
        sourceId: 1,
        sessionId: 'duplicate',
        turnIndex: 1,
        callIndex: 0,
        provider: 'codex',
        model: 'gpt-5.4',
        timestamp: 'invalid',
        bashCommands: [],
      },
      {
        sourceId: 1,
        sessionId: 'duplicate',
        turnIndex: 2,
        callIndex: 0,
        provider: 'codex',
        model: 'gpt-5.4',
        timestamp: '2026-01-01T00:00:01.000Z',
        bashCommands: [],
      },
    )
    expect(searchSessionsFromData(data, 'target', catalogue)).toEqual([
      {
        sessionId: 'duplicate',
        project: 'project',
        provider: 'codex',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'message',
        snippet: 'target valid turn',
      },
    ])
  })

  it('does not cap raw facts, returns hit 500, and omits hit 501', () => {
    const data = emptyData()
    for (let index = 0; index < 501; index++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
      addSession(data, index + 1, `session-${String(index).padStart(3, '0')}`, timestamp, 'all target', [
        'ordinary command',
      ])
    }
    const hits = searchSessionsFromData(data, 'target', catalogue)
    expect(hits).toHaveLength(500)
    expect(hits.at(-1)?.sessionId).toBe('session-499')
    expect(hits.some(hit => hit.sessionId === 'session-500')).toBe(false)
  })

  it('returns immediately for an empty trimmed query', () => {
    expect(searchSessionsFromData(emptyData(), ' \n\t ', catalogue)).toEqual([])
  })

  it('uses current aliases and object-key model order when admitted calls have no provider', () => {
    const data = emptyData()
    addSession(data, 1, 'fallback', '2026-01-02T00:00:00.000Z', 'target', ['echo'])
    const first = data.calls[0]!
    data.calls[0] = { ...first, provider: '', model: 'legacy-model' }
    data.aliases.push({ model: 'legacy-model', aliasOf: 'gpt-5.4' })
    expect(searchSessionsFromData(data, 'target', catalogue)[0]?.provider).toBe('codex')

    data.calls.push({ ...first, callIndex: 1, provider: '', model: '2' })
    expect(searchSessionsFromData(data, 'target', catalogue)[0]?.provider).toBe('unknown')
  })
})
