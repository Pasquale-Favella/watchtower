import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { copilot } from '../src/infrastructure/provider-adapters/copilot.js'
import type { SessionSource } from '../src/infrastructure/provider-adapters/types.js'
import { providerParserIterator } from './fixtures/provider-effects.js'

/**
 * The Copilot CLI writes a per-model input/cache rollup on `session.shutdown`,
 * and that rollup is the ONLY place a CLI session records input and cache
 * tokens - its per-turn `assistant.message` events carry output only.
 *
 * Two things used to stop that reaching the ledger, both covered here.
 */
function cliSession(events: unknown[]): { root: string; source: SessionSource } {
  const root = mkdtempSync(join(tmpdir(), 'copilot-cli-rollup-'))
  const dir = join(root, 'session-state', 'sess-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.yaml'), 'cwd: C:/repo/demo\n')
  writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
  return {
    root,
    source: {
      path: join(dir, 'events.jsonl'),
      project: 'demo',
      provider: 'copilot',
      sourceType: 'jsonl',
      sessionKind: 'cli',
    } as SessionSource,
  }
}

function start(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'session.start', data: { sessionId: 'sess-1', ...extra } }
}

function shutdown(inputTokens: number, cacheRead: number, output = 0): Record<string, unknown> {
  return {
    type: 'session.shutdown',
    data: {
      modelMetrics: {
        'claude-sonnet-4-6': { usage: { inputTokens, outputTokens: output, cacheReadTokens: cacheRead } },
      },
    },
  }
}

async function collect(source: SessionSource): Promise<Array<Record<string, unknown>>> {
  const seen = new Set<string>()
  const out: Array<Record<string, unknown>> = []
  for await (const call of providerParserIterator(copilot.createSessionParser(source, seen))) {
    out.push(call as unknown as Record<string, unknown>)
  }
  return out
}

afterEach(() => {
  delete process.env['WATCHTOWER_COPILOT_SESSION_STATE_DIR']
  delete process.env['WATCHTOWER_COPILOT_SESSION_STORE_DB']
})

describe('copilot CLI shutdown rollup', () => {
  it('reads the rollup for a CLI session even though it carries the transcript producer', async () => {
    // The CLI and a VS Code transcript both write
    // `session.start.producer === 'copilot-agent'`. Deciding "is this a
    // transcript?" from that field read every CLI session as a transcript, and a
    // transcript is exactly the shape whose rollup is not trusted - so every
    // CLI session contributed its per-turn output and NOTHING else, and all of
    // its input and cache tokens went unrecorded.
    const { source } = cliSession([
      start({ producer: 'copilot-agent' }),
      { type: 'assistant.message', data: { messageId: 'm1', model: 'claude-sonnet-4-6', outputTokens: 500 } },
      shutdown(1_000_000, 900_000),
    ])

    const calls = await collect(source)
    const rollup = calls.find(c => String(c['deduplicationKey']).includes(':shutdown:'))
    expect(rollup).toBeDefined()
    // input_tokens is cache-INCLUSIVE, so uncached input is 1,000,000 - 900,000.
    expect(rollup!['inputTokens']).toBe(100_000)
    expect(rollup!['cacheReadInputTokens']).toBe(900_000)
    // Output is deliberately excluded: the per-turn message owns it.
    expect(rollup!['outputTokens']).toBe(0)
    expect(rollup!['costIsEstimated']).toBe(false)
    // And the per-turn output call is still there, unduplicated.
    expect(calls.filter(c => !String(c['deduplicationKey']).includes(':shutdown:'))).toHaveLength(1)
  })

  it('serves one delta per resumed leg, each under its own key', async () => {
    // A resumed session writes one rollup PER LEG, each reporting CUMULATIVE
    // counters, so serving a leg whole would bill the earlier requests again on
    // every resume. Each leg keeps its own key: the cache is append-only by
    // dedup key, so a later resume appends a row instead of rewriting one.
    const { source } = cliSession([
      start(),
      shutdown(100_000, 20_000),
      shutdown(160_000, 30_000),
      // Below its predecessor: a fresh accounting epoch (the CLI resets at an
      // in-session compaction), taken at face value, never clamped away.
      shutdown(90_000, 10_000),
    ])

    const calls = await collect(source)
    const rollups = calls.filter(c => String(c['deduplicationKey']).includes(':shutdown:'))
    expect(rollups.map(c => c['deduplicationKey'])).toEqual([
      'copilot:sess-1:shutdown:claude-sonnet-4-6:1',
      'copilot:sess-1:shutdown:claude-sonnet-4-6:2',
      'copilot:sess-1:shutdown:claude-sonnet-4-6:3',
    ])
    expect(rollups.map(c => [c['inputTokens'], c['cacheReadInputTokens']])).toEqual([
      [80_000, 20_000],
      [50_000, 10_000],
      [80_000, 10_000],
    ])
  })

  it('prices a leg from GitHub’s own bill when the rollup carries totalNanoAiu', async () => {
    // CLI 1.0.8x and the VS Code agent host write no per-turn output, so the leg
    // carries it — and `totalNanoAiu` makes the credits for that leg exact (the
    // figure is a running bill; only its delta belongs to this leg).
    const { source } = cliSession([
      start(),
      {
        type: 'session.shutdown',
        data: {
          modelMetrics: {
            'claude-sonnet-4-6': {
              usage: { inputTokens: 1_000, outputTokens: 500 },
              totalNanoAiu: 2_500_000_000,
            },
          },
        },
      },
    ])

    const [call] = await collect(source)
    // 2.5e9 nano-AIU = 2.5 credits = $0.025, whatever the tokens price at.
    expect(call!['costUSD']).toBeCloseTo(0.025, 10)
    expect(call!['costIsEstimated']).toBe(false)
    expect(call!['outputTokens']).toBe(500)
    expect(call!['inputTokens']).toBe(1_000)
  })

  it('still refuses the rollup for a real VS Code transcript', async () => {
    // The classification is now by file location, so a transcript found under a
    // `transcripts/` directory is still a transcript and its rollup is still
    // untrusted. Without a model to infer it returns nothing at all.
    const root = mkdtempSync(join(tmpdir(), 'copilot-transcript-'))
    const dir = join(root, 'transcripts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'sess-2.jsonl')
    writeFileSync(
      path,
      [start({ producer: 'copilot-agent' }), shutdown(1_000_000, 900_000)].map(e => JSON.stringify(e)).join('\n'),
    )
    const calls = await collect({
      path,
      project: 'demo',
      provider: 'copilot',
      sourceType: 'jsonl',
      sessionKind: 'transcript',
    } as SessionSource)
    expect(calls.filter(c => String(c['deduplicationKey']).includes(':shutdown:'))).toHaveLength(0)
  })
})
