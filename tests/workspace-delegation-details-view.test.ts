import { describe, expect, it } from 'vitest'

import { delegationDetailsPreview } from '@/renderer/features/workspace/delegation/delegation-view.js'
import {
  delegationDetailsElapsed,
  groupDelegationDetails,
} from '@/renderer/features/workspace/delegation/details-view.js'

describe('delegation details groups', () => {
  it('puts live tasks first and orders each group by creation time', () => {
    const records = [
      { title: 'Running', status: 'running', createdAt: '2026-11-19T10:00:00Z', settledAt: null },
      { title: 'Failed', status: 'failed', createdAt: '2026-11-19T10:01:00Z', settledAt: '2026-11-19T10:02:00Z' },
      { title: 'Waiting', status: 'waiting', createdAt: '2026-11-19T11:02:00+01:00', settledAt: null },
      { title: 'Queued', status: 'queued', createdAt: '2026-11-19T10:03:00Z', settledAt: null },
      { title: 'Completed', status: 'completed', createdAt: '2026-11-19T10:04:00Z', settledAt: '2026-11-19T10:05:00Z' },
    ] as const

    const { active, previous } = groupDelegationDetails(records)

    expect(active.map(record => record.title)).toEqual(['Queued', 'Waiting', 'Running'])
    expect(previous.map(record => record.title)).toEqual(['Completed', 'Failed'])
  })
})

describe('delegation details elapsed', () => {
  const createdAt = '2026-11-19T10:00:00Z'
  const openedAt = Date.parse('2026-11-19T10:01:10Z')

  it('measures live time at the supplied clock reading', () => {
    expect(delegationDetailsElapsed({ createdAt, settledAt: null, status: 'running' }, openedAt)).toBe(70_000)
  })

  it('stops counting at settlement', () => {
    expect(
      delegationDetailsElapsed({ createdAt, settledAt: '2026-11-19T10:00:09Z', status: 'completed' }, openedAt),
    ).toBe(9000)
  })

  it('leaves elapsed time unknown for a terminal record with no settlement timestamp', () => {
    expect(delegationDetailsElapsed({ createdAt, settledAt: null, status: 'failed' }, openedAt)).toBeNull()
  })
})

describe('delegation details preview', () => {
  it('shows a compact excerpt of up to 280 characters when the task settles', () => {
    const settled = { status: 'completed', settledAt: '2026-11-19T10:05:00Z', pendingRequest: null } as const
    expect(delegationDetailsPreview({ ...settled, resultText: ' Review\n\n complete. ' })).toBe('Review complete.')
    expect(delegationDetailsPreview({ ...settled, resultText: 'a'.repeat(281) })).toBe(`${'a'.repeat(279)}…`)
  })

  it('describes progress while the task is live', () => {
    expect(
      delegationDetailsPreview({
        status: 'running',
        settledAt: null,
        pendingRequest: null,
        resultText: 'Partial result',
      }),
    ).toBe('Working…')
    expect(
      delegationDetailsPreview({
        status: 'waiting',
        settledAt: null,
        pendingRequest: { requestId: 'q', kind: 'question' },
        resultText: null,
      }),
    ).toBe('Waiting for an answer')
  })
})
