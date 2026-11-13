import { describe, expect, it } from 'vitest'

import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import {
  canClearCapturedDraft,
  capturePendingStart,
  clearPendingStart,
  emptyPendingStartStore,
  markPendingStartUncertain,
  PENDING_START_MAX_CONVERSATIONS,
  PENDING_START_RETENTION_MS,
  type PendingStartStorage,
  readPendingStartStore,
} from '@/renderer/features/workspace/pending-start-state.js'
import { conversationIdSchema, taskIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

class MemoryStorage implements PendingStartStorage {
  value: string | null = null

  getItem() {
    return this.value
  }

  setItem(_key: string, value: string) {
    this.value = value
  }

  removeItem() {
    this.value = null
  }
}

const startCommand = (index = 1): WorkspaceRequest<'workspace:startRun'> => ({
  commandId: `command-${index}`,
  taskId: taskIdSchema.make(`task-${index}`),
  conversationId: conversationIdSchema.make(`conversation-${index}`),
  checkoutId: workspaceCheckoutIdSchema.make(`checkout-${index}`),
  generation: 1,
  driverId: 'harness',
  connectionId: 'connection-1',
  prompt: `prompt ${index}`,
  modelId: null,
  modeId: null,
  nativeSessionId: null,
  retryOfRunId: null,
})

describe('pending Run start state', () => {
  it('persists the immutable full command and hydrates it as uncertain', () => {
    const storage = new MemoryStorage()
    const command = startCommand()
    const captured = capturePendingStart(
      storage,
      emptyPendingStartStore,
      {
        conversationId: command.conversationId,
        command,
        rawDraft: 'prompt 1\nnew line',
      },
      100,
    )

    expect(captured.error).toBeNull()
    const restored = readPendingStartStore(storage, 101)
    expect(restored.error).toBeNull()
    expect(restored.records[command.conversationId]).toMatchObject({
      command,
      rawDraft: 'prompt 1\nnew line',
      state: 'uncertain',
      updatedAt: 100,
    })
    expect(canClearCapturedDraft('prompt 1\nnew text', 'prompt 1\nnew line')).toBe(false)
    expect(canClearCapturedDraft('prompt 1\nnew line', 'prompt 1\nnew line')).toBe(true)
  })

  it('requires retries to preserve the original payload and draft', () => {
    const storage = new MemoryStorage()
    const command = startCommand()
    const captured = capturePendingStart(storage, emptyPendingStartStore, {
      conversationId: command.conversationId,
      command,
      rawDraft: 'original',
    })
    const uncertain = markPendingStartUncertain(storage, captured, command.conversationId, command.commandId)
    const rejected = capturePendingStart(storage, uncertain, {
      conversationId: command.conversationId,
      command: { ...command, prompt: 'edited' },
      rawDraft: 'edited',
    })
    expect(rejected.error).toContain('original pending Run payload')
    const retried = capturePendingStart(storage, uncertain, {
      conversationId: command.conversationId,
      command,
      rawDraft: 'original',
    })
    expect(retried.records[command.conversationId].state).toBe('pending')
  })

  it('clears only the matching command and never evicts records at capacity', () => {
    const storage = new MemoryStorage()
    let store = emptyPendingStartStore
    for (let index = 1; index <= PENDING_START_MAX_CONVERSATIONS; index += 1) {
      const command = startCommand(index)
      store = capturePendingStart(storage, store, {
        conversationId: command.conversationId,
        command,
        rawDraft: command.prompt,
      })
    }
    const extra = startCommand(PENDING_START_MAX_CONVERSATIONS + 1)
    const rejected = capturePendingStart(storage, store, {
      conversationId: extra.conversationId,
      command: extra,
      rawDraft: extra.prompt,
    })
    expect(rejected.error).toContain('40 pending Run intent limit')
    expect(Object.keys(rejected.records)).toHaveLength(PENDING_START_MAX_CONVERSATIONS)
    expect(clearPendingStart(storage, store, startCommand().conversationId, 'other-command').records).toHaveProperty(
      startCommand().conversationId,
    )
    const cleared = clearPendingStart(storage, store, startCommand().conversationId, startCommand().commandId)
    expect(cleared.error).toBeNull()
    expect(Object.keys(cleared.records)).toHaveLength(PENDING_START_MAX_CONVERSATIONS - 1)
  })

  it('blocks malformed persisted data and flags old unresolved receipts without deleting them', () => {
    const storage = new MemoryStorage()
    storage.value = '{bad json'
    expect(readPendingStartStore(storage).error).toContain('invalid')

    storage.value = null
    const command = startCommand()
    capturePendingStart(
      storage,
      emptyPendingStartStore,
      {
        conversationId: command.conversationId,
        command,
        rawDraft: command.prompt,
      },
      1,
    )
    const old = readPendingStartStore(storage, PENDING_START_RETENTION_MS + 2)
    expect(old.error).toContain('older than 60 days')
    expect(old.records[command.conversationId]).toBeDefined()
  })
})
