import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DelegationDetailsView } from '../src/renderer/features/workspace/delegation/DelegationDetails.js'
import {
  DelegationStripView,
  type DelegationStripViewProps,
} from '../src/renderer/features/workspace/delegation/DelegationStrip.js'
import { DelegationWakeNoticeView } from '../src/renderer/features/workspace/delegation/DelegationWakeNotice.js'
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
      child: null,
      isStopPending: () => false,
      onOpen: noop,
      onStop: noop,
      ...values,
    }),
  )
}

describe('delegation strip', () => {
  it('renders nothing without live delegations, held wakes or a parent Task', () => {
    expect(strip()).toBe('')
  })

  it('lists live delegations with Open and Stop controls that have accessible names', () => {
    const markup = strip({ records: [record('a'), record('b')] })
    expect(markup).toContain('Delegate a')
    expect(markup).toContain('Delegate b')
    expect(markup).toContain('aria-label="Stop delegated task Delegate a"')
    expect(markup).toContain('aria-label="Open delegated task Delegate b"')
    expect(markup).toContain('role="status"')
  })

  it('collapses more than two delegations to a tally with an expand control', () => {
    const markup = strip({ records: [record('a'), record('b'), record('c')] })
    expect(markup).toContain('3 running · Show all')
    expect(markup).not.toContain('aria-label="Open delegated task Delegate a"')
    expect(markup).toContain('aria-expanded="false"')
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
    expect(markup).toContain('aria-label="Open delegated task Delegate ask"')
  })

  it('shows the child context with Runs on its own and Open parent', () => {
    const markup = strip({ child: { status: 'running' }, onOpenParent: noop })
    expect(markup).toContain('Runs on its own · Running')
    expect(markup).toContain('Open parent')
  })

  it('disables Stop while a stop is pending or already requested', () => {
    const pending = strip({ records: [record('a')], isStopPending: () => true })
    expect(buttonTag(pending, 'Stop delegated task Delegate a')).toContain('disabled')
    const requested = strip({ records: [record('b', { cancelRequestedAt: '2026-11-19T10:01:00.000Z' })] })
    expect(buttonTag(requested, 'Stop delegated task Delegate b')).toContain('disabled')
  })
})

describe('delegation wake notice', () => {
  it('states the settled status of the delegated task and offers Open, never a user message', () => {
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
    expect(markup).toContain('Delegated task Check the migration settled as completed')
    expect(markup).toContain('aria-label="Delegated task settled"')
    expect(markup).toContain('aria-label="Open Check the migration"')
  })
})

describe('delegation details section', () => {
  it('lists delegations with status, Open and Stop, and reports an empty list', () => {
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
    expect(markup).toContain('Failed')

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
    expect(empty).toContain('No delegated tasks')
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
})
