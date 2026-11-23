import { describe, expect, it } from 'vitest'

import { narrowChildAccessMode } from '@/core/domain/delegation/access-narrowing.js'
import { delegationStatusFromRun, isSettledDelegationStatus } from '@/core/domain/delegation/status.js'
import { delegationWakePrompt } from '@/core/domain/delegation/wake.js'
import {
  isClaudeOrchestratorTool,
  isClaudeReadOnlyOrchestratorTool,
  isCodexOrchestratorTool,
  isOrchestratorToolTitle,
  orchestrationReference,
  orchestrationReferenceFromRaw,
} from '@/infrastructure/agent-harnesses/orchestration.js'
import type { AgentAccessMode, AgentRunStatus } from '@/shared/schemas/execution.js'

const ALL: ReadonlyArray<AgentAccessMode> = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']

describe('child access narrowing', () => {
  it.each([
    ['full-access', undefined, ALL, 'granted', 'full-access', null],
    [
      'auto',
      undefined,
      ['approval-required', 'auto-accept-edits', 'full-access'],
      'granted',
      'auto-accept-edits',
      'auto',
    ],
    ['approval-required', undefined, ['approval-required', 'auto-accept-edits'], 'granted', 'approval-required', null],
    ['auto-accept-edits', 'full-access', ALL, 'refused', 'access-escalation-denied', null],
    [
      'full-access',
      'auto',
      ['approval-required', 'auto-accept-edits', 'full-access'],
      'refused',
      'unsupported-access-mode',
      null,
    ],
    ['full-access', 'approval-required', ALL, 'granted', 'approval-required', null],
  ] as const)(
    'parent %s, requested %s, supported %j -> %s %s',
    (parent, requested, supported, outcome, detail, steppedDownFrom) => {
      const result = narrowChildAccessMode({ parent, requested, supported })
      expect(result.outcome).toBe(outcome)
      if (result.outcome === 'granted') {
        expect(result.mode).toBe(detail)
        expect(result.steppedDownFrom).toBe(steppedDownFrom)
      } else {
        expect(result.code).toBe(detail)
      }
    },
  )

  it('refuses an empty supported list when the request is explicit, and uses the fail-safe default otherwise', () => {
    expect(narrowChildAccessMode({ parent: 'auto', requested: 'auto', supported: [] }).outcome).toBe('refused')
    expect(narrowChildAccessMode({ parent: 'auto', requested: undefined, supported: [] }).outcome).toBe('refused')
  })
})

describe('delegation status', () => {
  const cases: ReadonlyArray<readonly [AgentRunStatus | null, boolean, boolean, string]> = [
    [null, false, false, 'queued'],
    ['queued', false, false, 'queued'],
    ['starting', false, false, 'running'],
    ['running', false, true, 'waiting'],
    ['awaitingInput', false, false, 'waiting'],
    ['interruptRequested', true, false, 'running'],
    ['completed', false, false, 'completed'],
    ['interrupted', false, false, 'interrupted'],
    ['interrupted', true, false, 'cancelled'],
    ['failed', false, false, 'failed'],
    ['uncertain', false, false, 'uncertain'],
    ['recoveryRequired', false, false, 'uncertain'],
  ]
  it.each(cases)(
    'maps run %s (cancel %s, pending %s) to %s',
    (runStatus, cancelRequested, pendingRequest, expected) => {
      expect(delegationStatusFromRun({ runStatus, cancelRequested, pendingRequest })).toBe(expected)
    },
  )

  it('treats only terminal delegation statuses as settled', () => {
    expect(isSettledDelegationStatus('completed')).toBe(true)
    expect(isSettledDelegationStatus('cancelled')).toBe(true)
    expect(isSettledDelegationStatus('running')).toBe(false)
    expect(isSettledDelegationStatus('waiting')).toBe(false)
  })
})

describe('delegation wake text', () => {
  it('frames the result as data from another agent and points at the delegation id', () => {
    const text = delegationWakePrompt({
      id: 'dlg-1' as never,
      title: 'Audit',
      status: 'completed',
      resultText: 'done',
      resultTruncated: false,
    })
    expect(text).toContain('Delegated task "Audit" settled as completed.')
    expect(text).toContain('data from another agent')
    expect(text).toContain('delegation_status with id dlg-1')
    expect(text).toContain('done')
  })

  it('says when the result was shortened and handles an empty result', () => {
    const text = delegationWakePrompt({
      id: 'dlg-2' as never,
      title: 'Long',
      status: 'failed',
      resultText: null,
      resultTruncated: true,
    })
    expect(text).toContain('(no result text)')
    expect(text).toContain('The result was shortened.')
  })
})

describe('orchestration tool recognition', () => {
  it('recognizes Claude, Codex and ACP orchestration tools by name', () => {
    expect(isClaudeOrchestratorTool('mcp__watchtower-orchestrator__delegation_start')).toBe(true)
    expect(isClaudeOrchestratorTool('mcp__watchtower-browser__preview_open')).toBe(false)
    expect(isClaudeReadOnlyOrchestratorTool('mcp__watchtower-orchestrator__delegation_status')).toBe(true)
    expect(isClaudeReadOnlyOrchestratorTool('mcp__watchtower-orchestrator__delegation_start')).toBe(false)
    expect(isCodexOrchestratorTool('watchtower-orchestrator', 'delegation_list')).toBe(true)
    expect(isCodexOrchestratorTool('watchtower-browser', 'delegation_list')).toBe(false)
    expect(isOrchestratorToolTitle('watchtower-orchestrator: delegation_cancel')).toBe(true)
    expect(isOrchestratorToolTitle('delegation_start')).toBe(true)
    expect(isOrchestratorToolTitle('mcp__watchtower-orchestrator__delegation_list')).toBe(true)
    expect(isOrchestratorToolTitle(null)).toBe(false)
    expect(isOrchestratorToolTitle('Read file')).toBe(false)
  })

  it('classifies only the orchestrator tool names, not any title that ends in a delegation_ suffix', () => {
    expect(isOrchestratorToolTitle('Run delegation_start')).toBe(false)
    expect(isOrchestratorToolTitle('my_delegation_status')).toBe(false)
    expect(isOrchestratorToolTitle('other-server: delegation_start')).toBe(false)
    expect(isOrchestratorToolTitle('watchtower-orchestrator: delegation_start_all')).toBe(false)
    expect(isOrchestratorToolTitle('watchtower-orchestrator: delegation_run')).toBe(false)
    expect(isOrchestratorToolTitle('mcp__watchtower-browser__delegation_start')).toBe(false)
  })

  it('reads the delegation reference from successful results only', () => {
    expect(orchestrationReference('{"id":"dlg-1","childTaskId":"task-1","status":"running"}')).toEqual({
      delegationId: 'dlg-1',
      childTaskId: 'task-1',
    })
    expect(orchestrationReference('{"code":"not-found","message":"x"}')).toBeUndefined()
    expect(orchestrationReferenceFromRaw({ structuredContent: { id: 'dlg-2' } })).toEqual({ delegationId: 'dlg-2' })
    expect(
      orchestrationReferenceFromRaw({ content: [{ type: 'text', text: '{"id":"dlg-3","childTaskId":"task-3"}' }] }),
    ).toEqual({ delegationId: 'dlg-3', childTaskId: 'task-3' })
  })
})
