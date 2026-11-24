import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DelegationDetailsView } from '../src/renderer/features/workspace/delegation/DelegationDetails.js'
import {
  DelegationStripView,
  type DelegationStripViewProps,
} from '../src/renderer/features/workspace/delegation/DelegationStrip.js'
import { DelegationWakeNoticeView } from '../src/renderer/features/workspace/delegation/DelegationWakeNotice.js'
import { readFullResult, resultCopySource } from '../src/renderer/features/workspace/delegation/result-copy.js'
import { DelegationRowView } from '../src/renderer/features/workspace/timeline/DelegationRow.js'
import type { ToolBlock } from '../src/renderer/features/workspace/timeline/work-log.js'
import type { DelegationRecord, DelegationWakeMessage } from '../src/shared/schemas/delegation.js'
import type { TaskId } from '../src/shared/schemas/workspace.js'

function record(id: string, values: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id,
    commandId: `command-${id}`,
    projectId: 'project-1',
    parentTaskId: 'task-parent',
    parentConversationId: 'conversation-parent',
    parentRunId: 'run-parent',
    childTaskId: `task-${id}`,
    childConversationId: `conversation-${id}`,
    childRunId: null,
    checkoutId: 'checkout-1',
    depth: 1,
    title: `Delegate ${id}`,
    driverId: 'codex',
    connectionId: 'codex-main',
    modelId: 'gpt-fast',
    modeId: null,
    accessMode: 'approval-required',
    accessModeRequested: null,
    accessModeSteppedDownFrom: null,
    isolation: 'shared',
    status: 'running',
    wake: 'always',
    wakeState: 'notDue',
    pendingRequest: null,
    resultText: null,
    resultTruncated: false,
    cancelRequestedAt: null,
    resultReadAt: null,
    createdAt: '2026-11-19T10:00:00.000Z',
    settledAt: null,
    ...values,
  } as DelegationRecord
}

const noop = () => undefined

function buttonTag(markup: string, label: string): string {
  return markup.match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>'))?.[0] ?? ''
}

function strip(values: Partial<DelegationStripViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DelegationStripView, {
      records: [],
      heldWake: false,
      isStopPending: () => false,
      onOpen: noop,
      onStop: noop,
      ...values,
    }),
  )
}

describe('delegation strip', () => {
  it('renders nothing without live delegations or held wakes', () => {
    expect(strip()).toBe('')
  })

  it('shows a calm summary line first and keeps the list closed while nothing needs the person', () => {
    const markup = strip({ records: [record('a'), record('b')] })
    expect(markup).toContain('Running')
    expect(markup).toContain('2 delegates')
    expect(markup).toContain('Details')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('2 running')
    expect(markup).not.toContain('aria-label="Open delegated task Delegate a"')
  })

  it('lists live delegations with status, Open and Stop controls that have accessible names', () => {
    const markup = strip({
      records: [record('a'), record('b', { status: 'queued' })],
      initiallyExpanded: true,
      harnessKinds: new Map([['codex-main', 'codex']]),
    })
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Delegate a')
    expect(markup).toContain('Delegate b')
    expect(markup).toContain('gpt-fast · Running')
    expect(markup).toContain('gpt-fast · Queued')
    expect(markup).toContain('aria-label="Stop delegated task Delegate a"')
    expect(markup).toContain('aria-label="Open delegated task Delegate b"')
    expect(markup).toContain('tabular-nums')
  })

  it('shows three rows and folds the rest behind Show N more', () => {
    const records = Array.from({ length: 55 }, (_, index) => record(String(index)))
    const markup = strip({ records, initiallyExpanded: true })
    expect(markup).toContain('Show 52 more')
    expect(markup.match(/aria-label="Open delegated task /g)).toHaveLength(3)
    expect(markup).not.toContain('max-h-56')
  })

  it('opens the list on its own when a delegate needs approval and names it in the summary', () => {
    const markup = strip({
      records: [
        record('run'),
        record('gate', { status: 'waiting', pendingRequest: { requestId: 'p', kind: 'approval' } }),
      ],
    })
    expect(markup).toContain('Waiting')
    expect(markup).toContain('1 needs approval')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('aria-label="Open delegated task Delegate gate"')
  })

  it('shows the held-wake note when a settled result waits for the user', () => {
    const markup = strip({
      records: [record('held', { status: 'completed', settledAt: '2026-11-19T10:05:00.000Z', wakeState: 'pending' })],
      heldWake: true,
    })
    expect(markup).toContain('Result held until you send a message.')
  })

  it('marks a waiting child and offers Open to answer it', () => {
    const markup = strip({
      records: [record('ask', { status: 'waiting', pendingRequest: { requestId: 'q', kind: 'question' } })],
    })
    expect(markup).toContain('Delegate waiting · Needs answer')
    expect(markup).toContain('>Needs answer<')
    expect(markup).toContain('aria-label="Open delegated task Delegate ask"')
  })

  it('disables Stop while a stop is pending or already requested', () => {
    const pending = strip({ records: [record('a')], isStopPending: () => true, initiallyExpanded: true })
    expect(buttonTag(pending, 'Stop delegated task Delegate a')).toContain('disabled')
    const requested = strip({
      records: [record('b', { cancelRequestedAt: '2026-11-19T10:01:00.000Z' })],
      initiallyExpanded: true,
    })
    expect(buttonTag(requested, 'Stop delegated task Delegate b')).toContain('disabled')
  })
})

describe('delegation wake notice', () => {
  it('links the settled delegated task with its outcome, never a user message', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationWakeNoticeView, {
        delegation: {
          delegationId: 'delegation-1',
          childTaskId: 'task-child' as TaskId,
          title: 'Check the migration',
          status: 'completed',
        } as DelegationWakeMessage,
        onOpen: noop,
      }),
    )
    expect(markup).toContain('Check the migration completed')
    expect(markup).toContain('<button')
    expect(markup).not.toContain('Result')
  })
})

describe('delegation details section', () => {
  it('shows every live delegate and held result while history is collapsed', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationDetailsView, {
        records: [
          ...Array.from({ length: 55 }, (_, index) => record(`live-${index}`)),
          record('held', { status: 'completed', wakeState: 'pending', settledAt: '2026-11-19T10:03:00Z' }),
          record('history', { status: 'completed', wakeState: 'delivered', settledAt: '2026-11-19T10:02:00Z' }),
        ],
        status: 'ready',
        error: null,
        truncated: true,
        isStopPending: () => false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup.match(/aria-label="Stop delegated task Delegate live-/g)).toHaveLength(55)
    expect(markup).toContain('aria-label="Pending delegation results"')
    expect(markup).toContain('Delegate held<')
    expect(markup).not.toContain('Delegate history<')
  })

  it('lists active delegations with Stop, folds settled ones under Previous, and hides when empty', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationDetailsView, {
        records: [record('a'), record('b', { status: 'failed', settledAt: '2026-11-19T10:02:00.000Z' })],
        status: 'ready',
        error: null,
        isStopPending: () => false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('aria-label="Delegated tasks"')
    expect(markup).toContain('aria-label="Stop delegated task Delegate a"')
    expect(markup).not.toContain('aria-label="Stop delegated task Delegate b"')
    expect(markup).toContain('Delegated tasks · 1 running')
    expect(markup).toContain('Previous tasks (1)')
    expect(markup).not.toContain('Delegate b<')

    const empty = renderToStaticMarkup(
      createElement(DelegationDetailsView, {
        records: [],
        status: 'ready',
        error: null,
        isStopPending: () => false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(empty).toBe('')
  })
})

describe('delegation details heading', () => {
  it('counts only running delegates as running and names the rest by their own status', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationDetailsView, {
        records: [
          record('a'),
          record('b'),
          record('c', { status: 'queued' }),
          record('d', { status: 'waiting', pendingRequest: { requestId: 'q', kind: 'question' } }),
        ],
        status: 'ready',
        error: null,
        isStopPending: () => false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('Delegated tasks · 2 running · 1 queued · 1 needs answer')
    expect(markup).toContain('>Queued<')
    expect(markup).toContain('>Needs answer<')
  })
})

describe('delegation timeline row', () => {
  const tool: ToolBlock = {
    kind: 'tool',
    toolCallId: 'call-42',
    name: 'mcp__watchtower-orchestrator__delegation_start',
    input: JSON.stringify({ prompt: 'Audit the lockfile' }),
    output: null,
    error: null,
    status: 'running',
    continued: false,
    sequence: 3,
    category: 'delegation',
    orchestration: { delegationId: 'delegation-a', childTaskId: 'task-a' },
  } as ToolBlock

  it('shows the durable record status, Open and Stop for a live delegation', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationRowView, {
        tool,
        delegation: record('a'),
        childTaskId: 'task-a' as TaskId,
        stopPending: false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('Delegate a')
    expect(markup).toContain('Running')
    expect(markup).toContain('aria-label="Open delegated task Delegate a"')
    expect(markup).toContain('aria-label="Stop delegated task Delegate a"')
  })

  it('shows the whole loaded result in place of the list preview', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationRowView, {
        tool,
        delegation: record('a', {
          status: 'failed',
          settledAt: '2026-11-19T10:05:00.000Z',
          resultText: 'Result preview',
        }),
        fullResultText: 'Result preview and the rest of the result',
        childTaskId: 'task-a' as TaskId,
        stopPending: false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('Result preview and the rest of the result')
  })

  it('falls back to the tool call while the record is not loaded, without Stop', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationRowView, {
        tool,
        delegation: null,
        childTaskId: null,
        stopPending: false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('Audit the lockfile')
    expect(markup).not.toContain('Stop delegated task')
    expect(markup).not.toContain('>Open<')
  })
  it('offers a copy of the result while only the preview is loaded', () => {
    const markup = renderToStaticMarkup(
      createElement(DelegationRowView, {
        tool,
        delegation: record('a', {
          status: 'failed',
          settledAt: '2026-11-19T10:05:00.000Z',
          resultText: 'Result preview',
        }),
        loadFullResult: () => Promise.resolve('Result preview and the rest of the result'),
        childTaskId: 'task-a' as TaskId,
        stopPending: false,
        onOpen: noop,
        onStop: noop,
      }),
    )
    expect(markup).toContain('aria-label="Copy delegated task result"')
  })
})

describe('Delegated task result copy', () => {
  const load = () => Promise.resolve('The whole result')

  it('copies the loaded whole result without another read', () => {
    expect(
      resultCopySource({
        fullResultText: 'The whole result',
        hasRecordResult: true,
        fallbackText: null,
        loadFullResult: load,
      }),
    ).toBe('The whole result')
  })

  it('reads the whole result on copy while only the preview is loaded, never copying the preview', async () => {
    const source = resultCopySource({
      fullResultText: undefined,
      hasRecordResult: true,
      fallbackText: 'preview',
      loadFullResult: load,
    })
    expect(typeof source).toBe('function')
    await expect((source as () => Promise<string>)()).resolves.toBe('The whole result')
  })

  it('fails the copy instead of copying the preview when the whole result cannot be read', async () => {
    const source = resultCopySource({
      fullResultText: null,
      hasRecordResult: true,
      fallbackText: 'preview',
      loadFullResult: undefined,
    })
    await expect((source as () => Promise<string>)()).rejects.toThrow('not available')
    await expect(readFullResult(() => Promise.reject(new Error('Delegation was not found')))).rejects.toThrow(
      'Delegation was not found',
    )
    await expect(readFullResult(() => Promise.resolve({ resultText: null }))).rejects.toThrow('no result')
    await expect(readFullResult(() => Promise.resolve({ resultText: 'ok' }))).resolves.toBe('ok')
  })

  it('copies a tool call text when there is no Delegation record', () => {
    expect(
      resultCopySource({
        fullResultText: undefined,
        hasRecordResult: false,
        fallbackText: 'tool output',
        loadFullResult: undefined,
      }),
    ).toBe('tool output')
    expect(
      resultCopySource({
        fullResultText: undefined,
        hasRecordResult: false,
        fallbackText: null,
        loadFullResult: undefined,
      }),
    ).toBeNull()
  })
})
