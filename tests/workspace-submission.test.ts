import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import { describe, expect, it } from 'vitest'

import {
  hydrateWorkspaceDrafts,
  updateWorkspaceDraftAtom,
  workspaceDraftsAtom,
} from '@/renderer/features/workspace/draft-atoms.js'
import {
  conversationSubmissionsAtom,
  hydratePendingStartStore,
  pendingStartStoreAtom,
  reconcileConversationSubmission,
  submissionMessageKeysAtom,
  updatePendingStartStoreAtom,
} from '@/renderer/features/workspace/pending-start-atoms.js'
import type { PendingStartCommand } from '@/renderer/features/workspace/pending-start-state.js'
import { deliverConversationSubmission } from '@/renderer/features/workspace/submission-lifecycle.js'
import { optimisticUserMessage, submissionEcho } from '@/renderer/features/workspace/submission-state.js'
import { WorkspaceRpcError } from '@/shared/rpc/workspace.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'
import type { CommandReceipt, WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

const command: PendingStartCommand = {
  commandId: 'start-command',
  taskId: taskIdSchema.make('task-1'),
  conversationId: conversationIdSchema.make('conversation-1'),
  checkoutId: workspaceCheckoutIdSchema.make('checkout-1'),
  generation: 1,
  driverId: 'fixture',
  connectionId: 'fixture',
  prompt: 'Send this message',
  nativeSessionId: null,
  retryOfRunId: null,
}
const receipt: CommandReceipt = {
  commandId: command.commandId,
  runId: agentRunIdSchema.make('run-1'),
  acceptedAt: '2026-11-03T12:00:00Z',
  replayed: false,
}

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const registry = AtomRegistry.make()
  hydrateWorkspaceDrafts(registry, storage)
  hydratePendingStartStore(registry, storage)
  registry.set(updatePendingStartStoreAtom, {
    kind: 'capture',
    record: {
      conversationId: command.conversationId,
      command,
      rawDraft: command.prompt,
      state: 'pending',
      updatedAt: Date.now(),
    },
  })
  return { registry, storage }
}

describe('conversation message delivery', () => {
  it('shows the message while the receipt is delayed and keeps it until the transcript echoes it', async () => {
    const { registry } = fixture()
    try {
      const accepted = Deferred.makeUnsafe<CommandReceipt>()
      const sending = Effect.runPromise(deliverConversationSubmission(registry, command, Deferred.await(accepted)))
      const before = registry.get(conversationSubmissionsAtom)[command.conversationId]
      const messageKey = optimisticUserMessage(before).id
      expect(before.state).toBe('sending')
      expect(optimisticUserMessage(before).message.content).toBe(command.prompt)
      await Effect.runPromise(Deferred.succeed(accepted, receipt))
      await expect(sending).resolves.toEqual(receipt)
      expect(registry.get(pendingStartStoreAtom).records[command.conversationId]).toBeUndefined()
      expect(registry.get(conversationSubmissionsAtom)[command.conversationId]).toMatchObject({
        state: 'sent',
        runId: receipt.runId,
      })
      expect(optimisticUserMessage(registry.get(conversationSubmissionsAtom)[command.conversationId]).id).toBe(
        messageKey,
      )
    } finally {
      registry.dispose()
    }
  })

  it('restores a rejected message to the editor and releases the blocked command', async () => {
    const { registry } = fixture()
    try {
      const error = new WorkspaceRpcError({ code: 'invalid-request', message: 'Workspace request is invalid.' })
      await expect(
        Effect.runPromise(deliverConversationSubmission(registry, command, Effect.fail(error))),
      ).rejects.toMatchObject({ code: 'invalid-request' })
      expect(registry.get(workspaceDraftsAtom)[command.conversationId]?.text).toBe(command.prompt)
      expect(registry.get(pendingStartStoreAtom).records[command.conversationId]).toBeUndefined()
      expect(registry.get(conversationSubmissionsAtom)[command.conversationId]).toMatchObject({
        state: 'failed',
        error: error.message,
      })
    } finally {
      registry.dispose()
    }
  })

  it('preserves a newer draft when the previous send is rejected', async () => {
    const { registry } = fixture()
    try {
      registry.set(updateWorkspaceDraftAtom, { conversationId: command.conversationId, text: 'A newer draft' })
      await Effect.runPromise(
        Effect.exit(
          deliverConversationSubmission(
            registry,
            command,
            Effect.fail(
              new WorkspaceRpcError({ code: 'conflict', message: 'Workspace command conflicts with existing state.' }),
            ),
          ),
        ),
      )
      expect(registry.get(workspaceDraftsAtom)[command.conversationId]?.text).toBe('A newer draft')
    } finally {
      registry.dispose()
    }
  })

  it('retains the exact command after a lost reply and reconciles an idempotent replay', async () => {
    const { registry, storage } = fixture()
    try {
      const disconnected = new RpcClientError({
        reason: new RpcClientDefect({ message: 'Disconnected', cause: undefined }),
      })
      await Effect.runPromise(Effect.exit(deliverConversationSubmission(registry, command, Effect.fail(disconnected))))
      const saved = registry.get(pendingStartStoreAtom).records[command.conversationId]
      expect(saved).toMatchObject({ state: 'uncertain', command })
      const restored = AtomRegistry.make()
      try {
        hydrateWorkspaceDrafts(restored, storage)
        hydratePendingStartStore(restored, storage)
        const recovered = restored.get(pendingStartStoreAtom).records[command.conversationId]
        expect(recovered.command).toEqual(command)
        restored.set(updatePendingStartStoreAtom, { kind: 'capture', record: { ...recovered, state: 'pending' } })
        await Effect.runPromise(
          deliverConversationSubmission(restored, recovered.command, Effect.succeed({ ...receipt, replayed: true })),
        )
        expect(restored.get(pendingStartStoreAtom).records[command.conversationId]).toBeUndefined()
        expect(restored.get(conversationSubmissionsAtom)[command.conversationId].runId).toBe(receipt.runId)
      } finally {
        restored.dispose()
      }
    } finally {
      registry.dispose()
    }
  })

  it('matches the durable echo before the RPC reply without confusing equal prompts or resurrecting a lost reply', async () => {
    const { registry } = fixture()
    try {
      const submission = registry.get(conversationSubmissionsAtom)[command.conversationId]
      const item: WorkspaceConversationPageItem = {
        event: {
          sequence: 1,
          schemaVersion: 1,
          kind: 'runQueued',
          runId: receipt.runId,
          taskId: command.taskId,
          generation: 1,
          occurredAt: receipt.acceptedAt,
          data: { commandId: command.commandId },
        },
        userMessage: { id: `user:${receipt.runId}`, content: command.prompt, createdAt: receipt.acceptedAt },
      }
      expect(submissionEcho(submission, [item])).toBe(item)
      expect(
        submissionEcho(submission, [{ ...item, event: { ...item.event, data: { commandId: 'another-command' } } }]),
      ).toBeUndefined()
      const delayed = Deferred.makeUnsafe<CommandReceipt, RpcClientError>()
      const reply = Effect.runPromise(
        Effect.exit(deliverConversationSubmission(registry, command, Deferred.await(delayed))),
      )
      reconcileConversationSubmission(registry, command.conversationId, [item])
      expect(registry.get(conversationSubmissionsAtom)[command.conversationId]).toBeUndefined()
      expect(registry.get(submissionMessageKeysAtom)[item.userMessage?.id ?? '']).toBe(
        optimisticUserMessage(submission).id,
      )
      await Effect.runPromise(
        Deferred.fail(
          delayed,
          new RpcClientError({ reason: new RpcClientDefect({ message: 'Disconnected', cause: undefined }) }),
        ),
      )
      await reply
      expect(registry.get(conversationSubmissionsAtom)[command.conversationId]).toBeUndefined()
      expect(registry.get(pendingStartStoreAtom).records[command.conversationId]).toBeUndefined()
    } finally {
      registry.dispose()
    }
  })
})
