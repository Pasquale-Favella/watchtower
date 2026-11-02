import { describe, expect, it } from 'vitest'

import {
  currentConversationRuns,
  isRunActive,
  shouldSubmitComposerKey,
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
