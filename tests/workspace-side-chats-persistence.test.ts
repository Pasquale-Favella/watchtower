import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'

import { SideChatPersistence } from '../src/core/application/commands/workspace-side-chats.js'
import { NodePlatformLive } from '../src/infrastructure/platform/platform-live.js'
import { sideChatPersistenceLayer } from '../src/infrastructure/workspace/side-chat-store.js'
import {
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '../src/shared/schemas/workspace.js'
import type { SideChatRecord } from '../src/shared/schemas/workspace-side-chats.js'
const parentTaskId = taskIdSchema.make('parent')
const parentConversationId = conversationIdSchema.make('parent-conversation')
const record: SideChatRecord = {
  binding: {
    id: 'side-chat:test',
    commandId: 'test',
    parentTaskId,
    parentConversationId,
    taskId: taskIdSchema.make('side-task:test'),
    conversationId: conversationIdSchema.make('side-conversation:test'),
    projectId: projectIdSchema.make('project'),
    checkoutId: workspaceCheckoutIdSchema.make('checkout'),
    parentHighWatermark: 3,
    contextTruncated: false,
    title: 'Side chat',
    createdAt: '2026-11-02T12:00:00Z',
  },
  context: 'User: first\nAssistant: captured response',
  request: { commandId: 'test', parentTaskId, parentConversationId },
}
function use<A, E>(directory: string, program: (store: SideChatPersistence['Service']) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.provide(
      Effect.flatMap(SideChatPersistence, program),
      sideChatPersistenceLayer(directory).pipe(Layer.provide(NodePlatformLive)),
    ),
  )
}
function cleanup(directory: string): void {
  if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error('Unexpected test directory')
  rmSync(directory, { recursive: true, force: true })
}
describe('side chat receipt files', () => {
  it('restores the immutable context and binding after the service is rebuilt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-side-chat-'))
    try {
      expect(await use(directory, store => store.get(record.binding.id))).toBeNull()
      await use(directory, store => store.put(record))
      expect(await use(directory, store => store.get(record.binding.id))).toEqual(record)
      expect(await use(directory, store => store.list())).toEqual([record])
    } finally {
      cleanup(directory)
    }
  })
  it('can restore the full allowed context even when JSON must escape every character', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-side-chat-'))
    try {
      const escaped = { ...record, context: '\u0000'.repeat(131072) }
      await use(directory, store => store.put(escaped))
      expect((await use(directory, store => store.get(record.binding.id)))?.context).toBe(escaped.context)
    } finally {
      cleanup(directory)
    }
  })
  it('reports corrupted receipts instead of substituting an empty parent context', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-side-chat-'))
    try {
      const file = createHash('sha256').update(JSON.stringify(record.binding.id)).digest('hex') + '.json'
      writeFileSync(join(directory, file), '{ broken')
      const error = await use(directory, store => Effect.flip(store.get(record.binding.id)))
      expect(error).toMatchObject({ code: 'unavailable' })
    } finally {
      cleanup(directory)
    }
  })
})
