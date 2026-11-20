import { describe, expect, it } from 'vitest'

import {
  canOpenAgentPicker,
  canSwitchAgentConnection,
  connectionHandoffTarget,
  currentConversationRuns,
  isRunActive,
  latestConversationSession,
  latestUnresolvedRun,
  shouldSubmitComposerKey,
  targetSelectionError,
  validateResumeSelection,
} from '@/renderer/features/workspace/composer-state.js'
import type { AgentRun } from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'
import type { WorkspaceNativeAgentSession, WorkspaceRunContext } from '@/shared/schemas/workspace-store.js'

const taskId = taskIdSchema.make('task-1')
const conversationId = conversationIdSchema.make('conversation-1')
const checkoutId = workspaceCheckoutIdSchema.make('checkout-1')
const run = (id: string, status: AgentRun['status']): AgentRun => ({
  id: agentRunIdSchema.make(id),
  taskId,
  sessionId: null,
  attempt: 1,
  retryOfRunId: null,
  generation: 1,
  status,
  submittedAt: '2026-11-02T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  nativeTurnId: null,
  failure: null,
})

describe('workspace composer state', () => {
  it('keeps the picker closed until the queue and pending submissions are confirmed', () => {
    const available = {
      queueExhaustive: true,
      pendingStart: false,
      submissionPending: false,
      handoffPendingRun: false,
    }
    expect(canOpenAgentPicker(available)).toBe(true)
    expect(canOpenAgentPicker({ ...available, queueExhaustive: false })).toBe(false)
    expect(canOpenAgentPicker({ ...available, handoffPendingRun: true })).toBe(false)
    expect(canOpenAgentPicker({ ...available, pendingStart: true })).toBe(false)
    expect(canOpenAgentPicker({ ...available, submissionPending: true })).toBe(false)
  })

  it('allows same-connection model choices during a Run but blocks connection changes until safe', () => {
    const available = {
      busy: false,
      queueExhaustive: true,
      queuedCount: 0,
      pendingStart: false,
      submissionPending: false,
    }
    expect(canSwitchAgentConnection(available)).toBe(true)
    expect(canSwitchAgentConnection({ ...available, busy: true })).toBe(false)
    expect(canSwitchAgentConnection({ ...available, queueExhaustive: false })).toBe(false)
    expect(canSwitchAgentConnection({ ...available, queuedCount: 1 })).toBe(false)
    expect(canSwitchAgentConnection({ ...available, pendingStart: true })).toBe(false)
    expect(canSwitchAgentConnection({ ...available, submissionPending: true })).toBe(false)
  })

  it('requires a fresh session only when the selected connection differs from the current Conversation session', () => {
    const session: WorkspaceNativeAgentSession = {
      id: 'session-handoff' as WorkspaceNativeAgentSession['id'],
      taskId,
      conversationId,
      checkoutId,
      connectionId: 'connection-a',
      driverId: 'driver-a',
      nativeSessionId: 'native-a',
      generation: 2,
      status: 'active',
    }

    expect(connectionHandoffTarget(session, 'connection-a')).toBeNull()
    expect(connectionHandoffTarget(session, 'connection-b')).toBe(session)
    expect(connectionHandoffTarget(null, 'connection-b')).toBeNull()
    expect(connectionHandoffTarget(session, '')).toBeNull()
  })

  it('names why a selected agent cannot take the next message, and stays silent while it is unknown', () => {
    const detected = new Set(['connection-a'])
    expect(targetSelectionError({ connectionId: '', detectedConnectionIds: detected, inspected: null })).toBeNull()
    expect(
      targetSelectionError({ connectionId: 'connection-a', detectedConnectionIds: detected, inspected: null }),
    ).toBeNull()
    expect(
      targetSelectionError({
        connectionId: 'connection-a',
        detectedConnectionIds: detected,
        inspected: { canSubmit: true },
      }),
    ).toBeNull()
    expect(
      targetSelectionError({
        connectionId: 'connection-gone',
        detectedConnectionIds: detected,
        inspected: null,
      }),
    ).toMatch(/no longer available/)
    expect(
      targetSelectionError({
        connectionId: 'connection-a',
        detectedConnectionIds: detected,
        inspected: { canSubmit: false },
      }),
    ).toMatch(/cannot continue this chat/)
  })

  it('continues the most recent matching native context and leaves stale or different contexts unselected', () => {
    const session: WorkspaceNativeAgentSession = {
      id: 'session-z' as WorkspaceNativeAgentSession['id'],
      taskId,
      conversationId,
      checkoutId,
      connectionId: 'connection-a',
      driverId: 'acp',
      nativeSessionId: 'native-first',
      generation: 1,
      status: 'active',
    }
    const newer = { ...session, id: 'session-a' as WorkspaceNativeAgentSession['id'], nativeSessionId: 'native-second' }
    const first = { ...run('run-first', 'completed'), sessionId: session.id }
    const last = { ...run('run-last', 'completed'), sessionId: newer.id, submittedAt: '2026-11-02T00:01:00Z' }
    expect(
      latestConversationSession([last, first], [newer, session], conversationId, checkoutId, 'connection-a'),
    ).toEqual(newer)
    expect(latestConversationSession([last], [newer], conversationId, checkoutId, 'other')).toBeNull()
    expect(
      latestConversationSession(
        [last],
        [{ ...newer, status: 'unavailable' }],
        conversationId,
        checkoutId,
        'connection-a',
      ),
    ).toBeNull()
  })
  it('submits only Enter without Shift or active IME composition', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(shouldSubmitComposerKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false)
  })

  it('classifies active Run states without treating completion as Task completion', () => {
    expect(isRunActive(run('run-active', 'running'))).toBe(true)
    expect(isRunActive(run('run-queued', 'queued'))).toBe(true)
    expect(isRunActive(run('run-complete', 'completed'))).toBe(false)
    expect(isRunActive(run('run-uncertain', 'uncertain'))).toBe(false)
  })

  it('keeps old terminal uncertainty in history without treating it as the latest unresolved attempt', () => {
    const uncertain = { ...run('run-old', 'uncertain'), submittedAt: '2026-11-02T00:00:00Z' }
    const completed = { ...run('run-new', 'completed'), submittedAt: '2026-11-02T00:01:00Z' }
    expect(latestUnresolvedRun([uncertain, completed])).toBeNull()
    expect(latestUnresolvedRun([completed, uncertain])).toBeNull()
    expect(latestUnresolvedRun([uncertain])).toBe(uncertain)
    const sameTimeCompleted = {
      ...completed,
      submittedAt: uncertain.submittedAt,
      id: 'run-z-completed' as AgentRun['id'],
    }
    const sameTimeUncertain = { ...uncertain, id: 'run-a-uncertain' as AgentRun['id'] }
    expect(latestUnresolvedRun([sameTimeUncertain, sameTimeCompleted])).toBeNull()
  })

  it('uses persisted Run contexts to select only the current Conversation', () => {
    const first = run('run-1', 'running')
    const second = run('run-2', 'completed')
    const context = (runId: AgentRun['id'], conversation: string): WorkspaceRunContext => ({
      runId,
      conversationId: conversationIdSchema.make(conversation),
      checkoutId,
      driverId: 'driver-a',
      connectionId: 'connection-a',
    })
    expect(
      currentConversationRuns(
        [first, second],
        [context(first.id, 'conversation-1'), context(second.id, 'other')],
        conversationId,
      ),
    ).toEqual([first])
  })

  it('requires an exact, available native session tuple before resuming', () => {
    const session: WorkspaceNativeAgentSession = {
      id: 'session-1' as WorkspaceNativeAgentSession['id'],
      taskId,
      conversationId,
      checkoutId,
      driverId: 'driver-a',
      connectionId: 'connection-a',
      nativeSessionId: 'native-1',
      generation: 3,
      status: 'suspended',
    }
    const selection = {
      taskId,
      conversationId,
      checkoutId,
      driverId: session.driverId,
      connectionId: session.connectionId,
      nativeSessionId: session.nativeSessionId,
      generation: session.generation,
    }
    expect(validateResumeSelection(selection, [session], new Set([checkoutId]))).toBe(session)
    expect(validateResumeSelection({ ...selection, generation: 2 }, [session], new Set([checkoutId]))).toBeNull()
    expect(validateResumeSelection(selection, [session], new Set())).toBeNull()
  })
})
