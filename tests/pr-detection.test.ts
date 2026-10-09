import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { queryPullRequestsView } from '../src/main/application/pull-requests-query.js'
import {
  cachedTurnToClassified,
  collectPrUrlsFromEntry,
  collectSessionMeta,
  compactEntry,
  emptySessionMeta,
  extractPrUrlsFromProviderCall,
  extractPrUrlsFromText,
  groupIntoTurns,
} from '../src/main/pipeline/parser.js'
import { codex } from '../src/main/pipeline/providers/codex.js'
import { buildAssistantCall } from '../src/main/pipeline/providers/session-message.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { sectionNeedsPrEvidenceReparse } from '../src/main/pipeline/session-cache.js'
import { shortenPrUrl } from '../src/main/pipeline/sessions-report.js'
import type { JournalEntry } from '../src/main/pipeline/types.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import type { WorkerRuntime } from '../src/main/worker-runtime.js'
import type { PortInput } from '../src/shared/schemas/port.js'
import { providerSectionSchema } from '../src/shared/schemas/session-cache.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

const GH = 'https://github.com/acme/repo/pull/12'
const GHE = 'https://ghe.corp.example.com/acme/widget/pull/34'
const GITLAB = 'https://gitlab.com/group/sub/repo/-/merge_requests/56'
const BITBUCKET = 'https://bitbucket.org/acme/repo/pull-requests/78'

describe('extractPrUrlsFromText (provider-neutral shapes)', () => {
  it('keeps matching classic github.com pull URLs', () => {
    expect(extractPrUrlsFromText(`working on ${GH} today`)).toEqual([GH])
  })

  it('matches http and enterprise hosts', () => {
    expect(extractPrUrlsFromText('see http://github.com/acme/repo/pull/12')).toEqual([
      'http://github.com/acme/repo/pull/12',
    ])
    expect(extractPrUrlsFromText(`fixing ${GHE}`)).toEqual([GHE])
  })

  it('matches GitLab merge requests incl. nested groups', () => {
    expect(extractPrUrlsFromText(`review ${GITLAB} please`)).toEqual([GITLAB])
  })

  it('matches Bitbucket pull-requests URLs', () => {
    expect(extractPrUrlsFromText(`see ${BITBUCKET}`)).toEqual([BITBUCKET])
  })

  it('strips trailing prose punctuation', () => {
    expect(extractPrUrlsFromText(`(${GH}).`)).toEqual([GH])
    expect(extractPrUrlsFromText(`see ${GH}, then deploy`)).toEqual([GH])
  })

  it('dedupes and sorts', () => {
    expect(extractPrUrlsFromText(`${GHE} and ${GH} and ${GHE}`)).toEqual([GHE, GH])
  })

  it('ignores bare issue numbers and non-PR URLs', () => {
    expect(extractPrUrlsFromText('fixes #123')).toEqual([])
    expect(extractPrUrlsFromText('https://github.com/acme/repo/issues/12')).toEqual([])
    expect(extractPrUrlsFromText('')).toEqual([])
  })
})

describe('extractPrUrlsFromProviderCall', () => {
  it('unions user message, bash commands and tool commands', () => {
    expect(
      extractPrUrlsFromProviderCall({
        userMessage: 'keep going',
        bashCommands: [`gh pr view ${GH} --comments`],
        toolSequence: [[{ command: `gh pr create --title x --body ${GHE}` }]],
      }),
    ).toEqual([GHE, GH])
  })

  it('scans provider-persisted assistant text', () => {
    expect(
      extractPrUrlsFromProviderCall({
        userMessage: 'ship it',
        assistantText: `Done, opened ${GITLAB} for review`,
      }),
    ).toEqual([GITLAB])
  })

  it('returns [] when nothing references a PR', () => {
    expect(extractPrUrlsFromProviderCall({ userMessage: 'refactor auth' })).toEqual([])
  })
})

describe('shortenPrUrl', () => {
  it('keeps the github.com owner/repo#n label', () => {
    expect(shortenPrUrl(GH)).toBe('acme/repo#12')
  })

  it('labels enterprise hosts by owner/repo', () => {
    expect(shortenPrUrl(GHE)).toBe('acme/widget#34')
  })

  it('labels nested GitLab groups by the last two segments', () => {
    expect(shortenPrUrl(GITLAB)).toBe('sub/repo#56')
  })

  it('labels Bitbucket pull-requests URLs', () => {
    expect(shortenPrUrl(BITBUCKET)).toBe('acme/repo#78')
  })

  it('falls back to the raw URL', () => {
    expect(shortenPrUrl('not-a-url')).toBe('not-a-url')
  })
})

function assistantEntry(text: string): JournalEntry {
  return {
    type: 'assistant',
    timestamp: '2026-07-20T10:00:00.000Z',
    sessionId: 'sess-1',
    message: {
      model: 'claude-opus-4-6',
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

function toolResultEntry(toolOutput: string): JournalEntry {
  return {
    type: 'user',
    timestamp: '2026-07-20T10:01:00.000Z',
    sessionId: 'sess-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: toolOutput }],
    },
    toolUseResult: { stdout: toolOutput },
  } as unknown as JournalEntry
}

describe('Claude assistant / tool-result PR capture', () => {
  it('collectPrUrlsFromEntry sees assistant text', () => {
    expect(collectPrUrlsFromEntry(assistantEntry(`Opened ${GH} for review.`))).toEqual([GH])
  })

  it('collectPrUrlsFromEntry sees gh output in tool results', () => {
    expect(collectPrUrlsFromEntry(toolResultEntry(`${GHE}\nCreated pull request.`))).toEqual([GHE])
  })

  it('collectSessionMeta unions text-level links with pr-link entries', () => {
    const meta = emptySessionMeta()
    collectSessionMeta(assistantEntry(`Working on ${GH}`), meta)
    collectSessionMeta({ type: 'pr-link', prUrl: GHE } as unknown as JournalEntry, meta)
    expect(meta.prLinks).toEqual([GH, GHE])
  })

  it('groupIntoTurns attributes assistant and tool-result URLs to the turn', () => {
    const userEntry: JournalEntry = {
      type: 'user',
      timestamp: '2026-07-20T09:59:00.000Z',
      sessionId: 'sess-1',
      message: { role: 'user', content: [{ type: 'text', text: 'implement the widget' }] },
    }
    const entries = [userEntry, assistantEntry(`Done, see ${GH}`), toolResultEntry(GHE)].map(raw => compactEntry(raw))
    const turns = groupIntoTurns(entries, new Set())
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prRefs).toEqual([GHE, GH])
  })
})

describe('cachedTurnToClassified fallback (pre-capture cache entries)', () => {
  it('re-extracts enterprise URLs from the stored user message', () => {
    const turn = buildFixtureCachedTurn(0, `please review ${GHE} today`)
    const classified = cachedTurnToClassified(turn)
    expect(classified.prRefs).toEqual([GHE])
  })

  it('re-extracts PR URLs from executed bash commands', () => {
    const call = { ...buildFixtureCachedCall(0), bashCommands: [`gh pr view ${GH} --json url`] }
    const turn = buildFixtureCachedTurn(0, 'check the pipeline', { calls: [call] })
    const classified = cachedTurnToClassified(turn)
    expect(classified.prRefs).toEqual([GH])
  })
})

describe('end-to-end: pre-capture shaped sessions reach the PR section', () => {
  function ledgerWithTurns(turns: CachedFile['turns'], prLinks?: string[]): WorkerRuntime {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile({ turns, ...(prLinks ? { prLinks } : {}) })
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'env-demo',
          filePath: '/cache/opencode/sess-9.jsonl',
          verdict: 'new',
          cachedFile: file,
        } satisfies PortInput),
      ),
    )
    return runtime
  }

  it('a session whose only evidence is a GHE link in the prompt appears', () => {
    const runtime = ledgerWithTurns([buildFixtureCachedTurn(0, `continue work on ${GHE}`)])
    const payload = runtime.runSync(
      atTime(queryPullRequestsView(viewInputs({ period: 'lifetime' })), new Date(2026, 7, 6)),
    )
    expect(payload.rows.map(r => r.url)).toEqual([GHE])
    expect(payload.rows[0]!.label).toBe('acme/widget#34')
  })

  it('a session whose only evidence is a gh command in the turn appears', () => {
    const call = { ...buildFixtureCachedCall(0), bashCommands: [`gh pr view ${GH} --comments`] }
    const runtime = ledgerWithTurns([buildFixtureCachedTurn(0, 'look at the failing check', { calls: [call] })])
    const payload = runtime.runSync(
      atTime(queryPullRequestsView(viewInputs({ period: 'lifetime' })), new Date(2026, 7, 6)),
    )
    expect(payload.rows.map(r => r.url)).toEqual([GH])
  })
})

describe('shared assistant-call seam (opencode / kilo-code)', () => {
  it('buildAssistantCall keeps assistant text as PR evidence', () => {
    const call = buildAssistantCall({
      providerName: 'opencode',
      dedupKey: 'opencode:sess-1:msg-1',
      sessionId: 'sess-1',
      data: { role: 'assistant', modelID: 'demo-model', tokens: { input: 10, output: 5 } },
      parts: [{ type: 'text', text: `Opened ${GH} for review` }],
      timeCreatedMs: Date.parse('2026-07-20T10:00:00.000Z'),
      userMessage: 'ship it',
    })
    expect(extractPrUrlsFromProviderCall(call!)).toEqual([GH])
    expect(call).toHaveProperty('assistantText')
  })

  it('buildAssistantCall keeps tool inputs as PR evidence', () => {
    const call = buildAssistantCall({
      providerName: 'opencode',
      dedupKey: 'opencode:sess-1:msg-2',
      sessionId: 'sess-1',
      data: { role: 'assistant', modelID: 'demo-model', tokens: { input: 10, output: 5 } },
      parts: [{ type: 'tool', tool: 'bash', state: { input: { command: `gh pr view ${GHE}` } } }],
      timeCreatedMs: Date.parse('2026-07-20T10:00:00.000Z'),
      userMessage: 'check ci',
    })
    expect(extractPrUrlsFromProviderCall(call!)).toEqual([GHE])
    expect(call).toHaveProperty('assistantText')
  })

  it('buildAssistantCall omits assistantText when there is no text', () => {
    const call = buildAssistantCall({
      providerName: 'opencode',
      dedupKey: 'opencode:sess-1:msg-3',
      sessionId: 'sess-1',
      data: { role: 'assistant', modelID: 'demo-model', tokens: { input: 10, output: 5 } },
      parts: [{ type: 'tool', tool: 'read', state: { input: {} } }],
      timeCreatedMs: Date.parse('2026-07-20T10:00:00.000Z'),
      userMessage: 'read the file',
    })
    expect(call).not.toHaveProperty('assistantText')
    expect(extractPrUrlsFromProviderCall(call!)).toEqual([])
  })
})

describe('codex assistant text reaches the PR seam', () => {
  it('emits assistantText naming the PR the agent printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-codex-pr-'))
    process.env['WATCHTOWER_CACHE_DIR'] = mkdtempSync(join(tmpdir(), 'tr-codex-cache-'))
    const filePath = join(dir, 'rollout-2026-07-20.jsonl')
    const lines = [
      {
        type: 'session_meta',
        timestamp: '2026-07-20T10:00:00.000Z',
        payload: { session_id: 'sess-x', cwd: '/work/demo', model: 'gpt-5' },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-20T10:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship the widget' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-20T10:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Done, opened ${GH}` }] },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-20T10:00:03.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: 100,
              input_tokens: 60,
              cached_input_tokens: 0,
              output_tokens: 30,
              reasoning_output_tokens: 10,
            },
            last_token_usage: {
              input_tokens: 60,
              cached_input_tokens: 0,
              output_tokens: 30,
              reasoning_output_tokens: 10,
            },
          },
        },
      },
    ]
    writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'))
    const parser = codex.createSessionParser({ path: filePath, project: 'demo', provider: 'codex' }, new Set())
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveProperty('assistantText')
    expect(extractPrUrlsFromProviderCall(calls[0]!)).toEqual([GH])
  })
})

describe('one-shot PR-evidence re-parse marker', () => {
  it('fires for sections written before the capture', () => {
    expect(sectionNeedsPrEvidenceReparse({})).toBe(true)
    expect(sectionNeedsPrEvidenceReparse({ prEvidenceV1: false })).toBe(true)
    expect(sectionNeedsPrEvidenceReparse({ prEvidenceV1: true })).toBe(false)
  })

  it('the section schema accepts old sections and stamped ones', () => {
    expect(Schema.decodeUnknownResult(providerSectionSchema)({ envFingerprint: 'x', files: {} })._tag).toBe('Success')
    const stamped = Schema.decodeUnknownSync(providerSectionSchema)({
      envFingerprint: 'x',
      files: {},
      prEvidenceV1: true,
    })
    expect(stamped.prEvidenceV1).toBe(true)
  })
})
