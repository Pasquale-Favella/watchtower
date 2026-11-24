import { describe, expect, it } from 'vitest'

import {
  delegateWaitingLabel,
  delegationHeadline,
  delegationStatusLabel,
  delegationStatusTone,
  delegationTally,
  delegationTallyLabel,
  heldWake,
  isLiveDelegation,
  sortStripDelegations,
  stripDelegations,
  visibleQueuedFollowUps,
} from '../src/renderer/features/workspace/delegation/delegation-status.js'
import { DelegationStopGuard } from '../src/renderer/features/workspace/delegation/delegation-stop.js'
import {
  delegationView,
  formatDelegateElapsed,
  nativeDelegateView,
  previewText,
} from '../src/renderer/features/workspace/delegation/delegation-view.js'
import type { ToolBlock } from '../src/renderer/features/workspace/timeline/work-log.js'
import type { DelegationRecord, DelegationStatus } from '../src/shared/schemas/delegation.js'

function record(values: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id: 'delegation-1',
    commandId: 'command-1',
    projectId: 'project-1',
    parentTaskId: 'task-parent',
    parentConversationId: 'conversation-parent',
    parentRunId: 'run-parent',
    childTaskId: 'task-child',
    childConversationId: 'conversation-child',
    childRunId: 'run-child',
    checkoutId: 'checkout-1',
    depth: 1,
    title: 'Check the migration',
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

describe('delegation status vocabulary', () => {
  it.each([
    ['queued', 'Queued', 'active'],
    ['running', 'Running', 'active'],
    ['waiting', 'Waiting', 'attention'],
    ['completed', 'Completed', 'success'],
    ['failed', 'Failed', 'failure'],
    ['interrupted', 'Stopped', 'neutral'],
    ['cancelled', 'Stopped', 'neutral'],
    ['uncertain', 'Uncertain', 'attention'],
  ] as const)('maps %s to a label and tone', (status, label, tone) => {
    expect(delegationStatusLabel(status as DelegationStatus)).toBe(label)
    expect(delegationStatusTone(status as DelegationStatus)).toBe(tone)
  })

  it('treats only unsettled queued, running and waiting delegations as live', () => {
    expect(isLiveDelegation(record({ status: 'running' }))).toBe(true)
    expect(isLiveDelegation(record({ status: 'waiting' }))).toBe(true)
    expect(isLiveDelegation(record({ status: 'completed', settledAt: '2026-11-19T10:05:00.000Z' }))).toBe(false)
    expect(isLiveDelegation(record({ status: 'running', settledAt: '2026-11-19T10:05:00.000Z' }))).toBe(false)
  })
})

describe('delegation tally', () => {
  it('counts live delegations by what they are doing, with waiting requests first', () => {
    const tally = delegationTally([
      record({ id: 'a' as DelegationRecord['id'], status: 'running' }),
      record({ id: 'b' as DelegationRecord['id'], status: 'running' }),
      record({
        id: 'c' as DelegationRecord['id'],
        status: 'waiting',
        pendingRequest: { requestId: 'q1', kind: 'question' },
      }),
      record({
        id: 'd' as DelegationRecord['id'],
        status: 'waiting',
        pendingRequest: { requestId: 'p1', kind: 'approval' },
      }),
      record({ id: 'e' as DelegationRecord['id'], status: 'queued' }),
      record({ id: 'f' as DelegationRecord['id'], status: 'completed', settledAt: '2026-11-19T10:05:00.000Z' }),
    ])
    expect(tally).toEqual({ running: 2, queued: 1, waiting: 0, needsAnswer: 1, needsApproval: 1 })
    expect(delegationTallyLabel(tally)).toBe('2 running · 1 queued · 1 needs answer · 1 needs approval')
  })

  it('counts running, queued and waiting separately and never files a running delegate as queued', () => {
    const tally = delegationTally([
      record({ id: 'a' as DelegationRecord['id'], status: 'running' }),
      record({ id: 'b' as DelegationRecord['id'], status: 'running' }),
      record({ id: 'c' as DelegationRecord['id'], status: 'queued' }),
      record({ id: 'd' as DelegationRecord['id'], status: 'waiting' }),
    ])
    expect(tally).toEqual({ running: 2, queued: 1, waiting: 1, needsAnswer: 0, needsApproval: 0 })
    expect(delegationTallyLabel(tally)).toBe('2 running · 1 queued · 1 waiting')
  })

  it('leads the headline with what needs the person, then running, then queued', () => {
    expect(delegationHeadline(delegationTally([record({ status: 'running' }), record({ status: 'running' })]))).toEqual(
      {
        phase: 'Running',
        tone: 'active',
        detail: '2 delegates',
      },
    )
    expect(
      delegationHeadline(
        delegationTally([
          record({ status: 'running' }),
          record({ status: 'waiting', pendingRequest: { requestId: 'p', kind: 'approval' } }),
        ]),
      ),
    ).toEqual({ phase: 'Waiting', tone: 'attention', detail: '1 needs approval' })
    expect(delegationHeadline(delegationTally([record({ status: 'queued' })]))).toMatchObject({
      phase: 'Queued',
      detail: '1 delegate',
    })
    expect(delegationHeadline(delegationTally([]))).toBeNull()
  })

  it('orders strip rows by what needs attention, then running, then queued, then held results', () => {
    const rows = sortStripDelegations([
      record({ id: 'queued' as DelegationRecord['id'], status: 'queued', createdAt: '2026-11-19T10:04:00.000Z' }),
      record({
        id: 'held' as DelegationRecord['id'],
        status: 'completed',
        settledAt: '2026-11-19T10:05:00.000Z',
        createdAt: '2026-11-19T10:05:00.000Z',
      }),
      record({ id: 'old' as DelegationRecord['id'], status: 'running', createdAt: '2026-11-19T10:01:00.000Z' }),
      record({ id: 'new' as DelegationRecord['id'], status: 'running', createdAt: '2026-11-19T10:03:00.000Z' }),
      record({
        id: 'ask' as DelegationRecord['id'],
        status: 'waiting',
        pendingRequest: { requestId: 'q', kind: 'question' },
        createdAt: '2026-11-19T10:00:00.000Z',
      }),
    ])
    expect(rows.map(row => row.id)).toEqual(['ask', 'new', 'old', 'queued', 'held'])
  })

  it('formats elapsed time compactly', () => {
    expect(formatDelegateElapsed(12_400)).toBe('12s')
    expect(formatDelegateElapsed(185_000)).toBe('3m 05s')
    expect(formatDelegateElapsed(3_720_000)).toBe('1h 02m')
    expect(formatDelegateElapsed(-5)).toBe('0s')
  })

  it('reads as nothing when no delegation is live', () => {
    expect(delegationTallyLabel(delegationTally([record({ status: 'failed' })]))).toBeNull()
  })

  it('describes a waiting child as the parent should show it', () => {
    expect(delegateWaitingLabel(record({ pendingRequest: { requestId: 'q', kind: 'question' } }))).toBe(
      'Delegate waiting · Needs answer',
    )
    expect(delegateWaitingLabel(record({ pendingRequest: { requestId: 'p', kind: 'approval' } }))).toBe(
      'Delegate waiting · Needs approval',
    )
    expect(delegateWaitingLabel(record())).toBeNull()
  })
})

describe('queued prompt list', () => {
  it('leaves out delegation wakes that deliver themselves and keeps paused ones and user prompts', () => {
    const items = [
      { id: 'wake', origin: 'delegation' as const },
      { id: 'user', origin: 'user' as const },
      { id: 'plain' },
      { id: 'held-wake', origin: 'delegation' as const, held: true },
    ]
    expect(visibleQueuedFollowUps(items).map(entry => [entry.item.id, entry.queueIndex, entry.number])).toEqual([
      ['user', 1, 1],
      ['plain', 2, 2],
      ['held-wake', 3, 3],
    ])
  })
})

describe('held wake rule', () => {
  const settled = { settledAt: '2026-11-19T10:05:00.000Z' }

  it('holds a settled wake that is pending while the parent has no active Run', () => {
    expect(heldWake(record({ ...settled, wakeState: 'pending' }), false)).toBe(true)
  })

  it('does not hold a wake while the parent Run is active, or once it is queued or delivered', () => {
    expect(heldWake(record({ ...settled, wakeState: 'pending' }), true)).toBe(false)
    expect(heldWake(record({ ...settled, wakeState: 'queued' }), false)).toBe(false)
    expect(heldWake(record({ ...settled, wakeState: 'delivered' }), false)).toBe(false)
    expect(heldWake(record({ wakeState: 'pending' }), false)).toBe(false)
  })

  it('keeps live delegations and held wakes in the strip, and nothing else', () => {
    const records = [
      record({ id: 'live' as DelegationRecord['id'], status: 'running' }),
      record({ id: 'held' as DelegationRecord['id'], status: 'completed', ...settled, wakeState: 'pending' }),
      record({ id: 'done' as DelegationRecord['id'], status: 'completed', ...settled, wakeState: 'delivered' }),
    ]
    expect(stripDelegations(records, false).map(item => item.id)).toEqual(['live', 'held'])
    expect(stripDelegations(records, true).map(item => item.id)).toEqual(['live'])
  })
})

describe('delegate views', () => {
  it('shows model, access, stepped-down access, isolation and the result preview of a Delegated Task', () => {
    const view = delegationView(
      record({
        status: 'completed',
        settledAt: '2026-11-19T10:00:12.500Z',
        accessMode: 'auto-accept-edits',
        accessModeSteppedDownFrom: 'auto',
        isolation: 'worktree',
        resultText: 'Migration  checked.\n\nNo  drift.',
      }),
      new Map([['codex-main', 'Codex']]),
    )
    expect(view).toMatchObject({
      title: 'Check the migration',
      statusLabel: 'Completed',
      tone: 'success',
      live: false,
      model: 'gpt-fast',
      connection: 'Codex',
      accessMode: 'Auto-accept edits',
      accessModeNote: 'Stepped down from Auto',
      isolation: 'Own worktree',
      durationMs: 12_500,
      preview: 'Migration checked. No drift.',
    })
  })

  it('labels a waiting child by the request it is waiting on', () => {
    expect(
      delegationView(record({ status: 'waiting', pendingRequest: { requestId: 'q', kind: 'question' } })),
    ).toMatchObject({ statusLabel: 'Needs answer', tone: 'attention', live: true })
  })

  it('reads a native subagent call from its tool metadata', () => {
    const tool = {
      kind: 'tool',
      toolCallId: 'call-1',
      name: 'Agent',
      input: JSON.stringify({ prompt: 'Review the diff' }),
      output: 'Looks fine to me.',
      error: null,
      status: 'completed',
      continued: false,
      sequence: 1,
      category: 'subagent',
      delegate: { model: 'fast-model', children: [] },
      durationMs: 800,
    } as ToolBlock
    expect(nativeDelegateView(tool)).toMatchObject({
      title: 'Review the diff',
      statusLabel: 'Completed',
      model: 'fast-model',
      durationMs: 800,
      preview: 'Looks fine to me.',
    })
  })

  it('shortens long previews to one line', () => {
    expect(previewText(null)).toBeNull()
    expect(previewText('   ')).toBeNull()
    const long = previewText('word '.repeat(100))
    expect(long).not.toBeNull()
    expect(long?.length).toBe(200)
    expect(long?.endsWith('…')).toBe(true)
  })
})

describe('stop requests', () => {
  it('sends one cancel per click and ignores a click while the first is in flight', async () => {
    const guard = new DelegationStopGuard()
    const sent: Array<{ commandId: string; delegationId: string }> = []
    let release: () => void = () => undefined
    const send = (command: { commandId: string; delegationId: string }) => {
      sent.push(command)
      return new Promise<void>(resolve => {
        release = resolve
      })
    }
    let counter = 0
    const newCommandId = () => `command-${(counter += 1)}`

    const first = guard.stop('delegation-1', send, newCommandId)
    expect(guard.isPending('delegation-1')).toBe(true)
    expect(await guard.stop('delegation-1', send, newCommandId)).toBe('skipped')
    release()
    expect(await first).toBe('sent')
    expect(sent).toEqual([{ commandId: 'command-1', delegationId: 'delegation-1' }])
    expect(guard.isPending('delegation-1')).toBe(false)
  })

  it('clears the pending state when the command fails so a later click can retry', async () => {
    const guard = new DelegationStopGuard()
    await expect(guard.stop('delegation-2', () => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    expect(guard.isPending('delegation-2')).toBe(false)
    const retry = await guard.stop('delegation-2', () => Promise.resolve(null))
    expect(retry).toBe('sent')
  })
})
