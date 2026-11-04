import { describe, expect, it } from 'vitest'

import type {
  ConversationAssistantTurn,
  ConversationRun,
  ConversationRunStatus,
  ConversationTurnBlock,
} from '../src/renderer/features/workspace/conversation-view.js'
import { formatRunDuration } from '../src/renderer/features/workspace/timeline/duration.js'
import {
  buildTurnSegments,
  isEmptySettledTurn,
  turnCopyText,
} from '../src/renderer/features/workspace/timeline/turn-segments.js'
import { summarizeToolCalls, toolCategory, toolPath } from '../src/renderer/features/workspace/timeline/work-log.js'

type Tool = Extract<ConversationTurnBlock, { kind: 'tool' }>

function tool(sequence: number, name: string, status: Tool['status'] = 'completed', input: string | null = null): Tool {
  return {
    kind: 'tool',
    toolCallId: `call-${sequence}`,
    name,
    input,
    output: null,
    error: status === 'failed' ? 'exit 1' : null,
    status,
    continued: false,
    sequence,
  }
}

const text = (sequence: number, value: string): ConversationTurnBlock => ({
  kind: 'text',
  text: value,
  itemId: `item-${sequence}`,
  sequence,
})

function run(status: ConversationRunStatus, seconds: number | null = 12.5): ConversationRun {
  const start = Date.parse('2026-10-30T12:00:00.000Z')
  return {
    runId: 'run-1' as ConversationRun['runId'],
    generation: 1,
    status,
    startedAt: seconds === null ? null : new Date(start).toISOString(),
    observedAt: new Date(start).toISOString(),
    settledAt: seconds === null ? null : new Date(start + seconds * 1000).toISOString(),
    pendingRequestKind: null,
    lastOutput: null,
  }
}

function turn(status: ConversationRunStatus, blocks: ConversationTurnBlock[], seconds: number | null = 12.5) {
  return { id: 'turn-1', run: run(status, seconds), blocks } satisfies Pick<
    ConversationAssistantTurn,
    'id' | 'run' | 'blocks'
  >
}

describe('duration formatting', () => {
  it('uses milliseconds under one second, one decimal under ten seconds, and pieces beyond', () => {
    expect(formatRunDuration(0)).toBe('0 ms')
    expect(formatRunDuration(850)).toBe('850 ms')
    expect(formatRunDuration(4_200)).toBe('4.2s')
    expect(formatRunDuration(12_000)).toBe('12s')
    expect(formatRunDuration(60_000)).toBe('1m 0s')
    expect(formatRunDuration(62_000)).toBe('1m 2s')
    expect(formatRunDuration(3_723_000)).toBe('1h 2m 3s')
  })

  it('clamps negative clock skew to zero', () => {
    expect(formatRunDuration(-40)).toBe('0 ms')
  })
})

describe('tool categories and summaries', () => {
  it('classifies tool names by their kind', () => {
    expect(toolCategory('Bash')).toBe('command')
    expect(toolCategory('run_terminal_cmd')).toBe('command')
    expect(toolCategory('Grep')).toBe('search')
    expect(toolCategory('Read')).toBe('read')
    expect(toolCategory('Edit')).toBe('edit')
    expect(toolCategory('apply_patch')).toBe('edit')
    expect(toolCategory('Teleport')).toBe('other')
  })

  it('reads the file a call names from its JSON input', () => {
    expect(toolPath('{"file_path":"src/a.ts"}')).toBe('src/a.ts')
    expect(toolPath('{"path":"src/b.ts"}')).toBe('src/b.ts')
    expect(toolPath('not json')).toBeNull()
    expect(toolPath(null)).toBeNull()
  })

  it('summarizes categories and counts distinct edited files', () => {
    const summary = summarizeToolCalls([
      tool(1, 'Bash'),
      tool(2, 'Bash'),
      tool(3, 'Bash'),
      tool(4, 'Edit', 'completed', '{"file_path":"a.ts"}'),
      tool(5, 'Edit', 'completed', '{"file_path":"a.ts"}'),
      tool(6, 'Edit', 'completed', '{"file_path":"b.ts"}'),
    ])
    expect(summary.label).toBe('Ran 3 commands, edited 2 files')
    expect(summary.toolCount).toBe(6)
    expect(summary.failedCount).toBe(0)
  })

  it('falls back to the call count when no category is recognized', () => {
    expect(summarizeToolCalls([tool(1, 'Teleport'), tool(2, 'Warp')]).label).toBe('2 tool calls')
    expect(summarizeToolCalls([tool(1, 'Teleport')]).label).toBe('1 tool call')
  })

  it('counts failed calls for the failure marker', () => {
    expect(summarizeToolCalls([tool(1, 'Bash', 'failed'), tool(2, 'Read')]).failedCount).toBe(1)
  })
})

describe('work log grouping', () => {
  it('groups consecutive calls and breaks on text, failures and running calls stay in their group', () => {
    const segments = buildTurnSegments(
      turn('active', [
        tool(1, 'Bash'),
        tool(2, 'Read'),
        text(3, 'Checking the result.'),
        tool(4, 'Edit'),
        tool(5, 'Bash', 'failed'),
        tool(6, 'Grep', 'running'),
      ]),
    )
    expect(segments.map(segment => segment.kind)).toEqual(['work', 'block', 'work', 'work', 'work'])
    const [first, , second, failed, last] = segments
    expect(first).toMatchObject({ kind: 'work', tools: [{ sequence: 1 }, { sequence: 2 }] })
    expect(second).toMatchObject({ kind: 'work', tools: [{ sequence: 4 }] })
    expect(failed).toMatchObject({ kind: 'work', tools: [{ sequence: 5 }], summary: { failedCount: 1 } })
    expect(last).toMatchObject({ kind: 'work', tools: [{ sequence: 6 }] })
  })

  it('breaks groups on requests and notices', () => {
    const segments = buildTurnSegments(
      turn('active', [
        tool(1, 'Bash'),
        { kind: 'notice', event: { kind: 'nativeNotice', message: 'hold' }, sequence: 2 },
        tool(3, 'Bash'),
      ]),
    )
    expect(segments.filter(segment => segment.kind === 'work')).toHaveLength(2)
  })
})

describe('turn folds', () => {
  it('folds routine activity of a completed Run into one row placed at the first group', () => {
    const segments = buildTurnSegments(
      turn('completed', [tool(1, 'Bash'), tool(2, 'Edit', 'completed', '{"file_path":"a.ts"}'), text(3, 'Done.')]),
    )
    expect(segments.map(segment => segment.kind)).toEqual(['fold', 'block'])
    expect(segments[0]).toMatchObject({
      kind: 'fold',
      label: 'Worked for 12s',
      groups: [{ tools: [{ sequence: 1 }, { sequence: 2 }] }],
      summary: { label: 'Ran 1 command, edited 1 file' },
    })
  })

  it('keeps an opened work row in place after its Run completes', () => {
    const completedTurn = turn('completed', [tool(1, 'Bash'), tool(2, 'Edit', 'completed', '{"file_path":"a.ts"}')])
    expect(buildTurnSegments(completedTurn).map(segment => segment.kind)).toEqual(['fold'])
    expect(buildTurnSegments(completedTurn, true).map(segment => segment.kind)).toEqual(['work'])
  })

  it('keeps failed calls visible while folding the routine calls of a completed Run', () => {
    const segments = buildTurnSegments(
      turn('completed', [tool(1, 'Bash'), tool(2, 'Bash', 'failed'), tool(3, 'Read'), text(4, 'Recovered.')]),
    )
    expect(segments.map(segment => segment.kind)).toEqual(['fold', 'work', 'block'])
    expect(segments[0]).toMatchObject({
      kind: 'fold',
      groups: [{ tools: [{ sequence: 1 }] }, { tools: [{ sequence: 3 }] }],
    })
    expect(segments[1]).toMatchObject({ kind: 'work', tools: [{ sequence: 2 }] })
  })

  it('labels an interrupted Run as stopped and an unknown duration without a figure', () => {
    const interrupted = buildTurnSegments(turn('interrupted', [tool(1, 'Bash')], 2))
    expect(interrupted[0]).toMatchObject({ kind: 'fold', label: 'You stopped after 2.0s' })

    const unknown = buildTurnSegments(turn('completed', [tool(1, 'Bash')], null))
    expect(unknown[0]).toMatchObject({ kind: 'fold', label: 'Worked' })

    const unknownStop = buildTurnSegments(turn('interrupted', [tool(1, 'Bash')], null))
    expect(unknownStop[0]).toMatchObject({ kind: 'fold', label: 'You stopped' })
  })

  it.each(['active', 'awaitingInput', 'failed', 'uncertain', 'recoveryRequired', 'queued'] as const)(
    'never folds a %s Run',
    status => {
      const segments = buildTurnSegments(turn(status, [tool(1, 'Bash'), tool(2, 'Read')]))
      expect(segments.some(segment => segment.kind === 'fold')).toBe(false)
    },
  )

  it('does not fold while a routine call is still running', () => {
    const segments = buildTurnSegments(turn('completed', [tool(1, 'Bash'), tool(2, 'Bash', 'running')]))
    expect(segments.some(segment => segment.kind === 'fold')).toBe(false)
  })

  it('does not fold a turn without tool activity', () => {
    const segments = buildTurnSegments(turn('completed', [text(1, 'Just words.')]))
    expect(segments).toEqual([{ kind: 'block', key: 'block:1', block: text(1, 'Just words.') }])
  })
})

describe('turn output helpers', () => {
  it('preserves plans between surrounding text and keeps them visible as content', () => {
    const plan: ConversationTurnBlock = {
      kind: 'plan',
      entries: [
        { content: 'Inspect', status: 'completed' },
        { content: 'Verify', status: 'pending' },
      ],
      explanation: 'Approach',
      itemId: 'plan-1',
      sequence: 2,
    }
    expect(turnCopyText(turn('completed', [text(1, 'Starting.'), plan, text(3, 'Done.')]))).toBe(
      'Starting.\n\nApproach\n\n- [x] Inspect\n- [ ] Verify\n\nDone.',
    )
    expect(isEmptySettledTurn(turn('completed', [plan]))).toBe(false)
    expect(
      buildTurnSegments(turn('completed', [tool(1, 'Bash'), plan, tool(3, 'Read')])).map(segment => segment.kind),
    ).toEqual(['fold', 'block'])
  })

  it('copies only non-empty text blocks, separated by blank lines', () => {
    expect(
      turnCopyText(turn('completed', [text(1, 'First.'), text(2, '  '), tool(3, 'Bash'), text(4, 'Second.')])),
    ).toBe('First.\n\nSecond.')
  })

  it('treats a settled turn with no text, tools, requests or notices as an empty response', () => {
    expect(isEmptySettledTurn(turn('completed', []))).toBe(true)
    expect(isEmptySettledTurn(turn('completed', [text(1, '   ')]))).toBe(true)
    expect(isEmptySettledTurn(turn('completed', [text(1, 'words')]))).toBe(false)
    expect(isEmptySettledTurn(turn('completed', [tool(1, 'Bash')]))).toBe(false)
    expect(isEmptySettledTurn(turn('active', []))).toBe(false)
  })
})
