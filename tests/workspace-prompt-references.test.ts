import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { createPromptReferenceFiles, createPromptReferenceIndex, searchMentionModels, searchMentionTasks } from '@/platform/electron/main/workspace/prompt-references.js'
import { collectPromptInlineTokens } from '@/renderer/features/workspace/prompt-tokens.js'
import { agentRunIdSchema, conversationIdSchema, projectIdSchema, type Task, taskIdSchema } from '@/shared/schemas/workspace.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const issued = '2026-11-09T12:00:00.000Z'
function task(id: string, title = id): Task {
  return { id: taskIdSchema.make(id), projectId: projectIdSchema.make('project'), title, description: '', status: 'open', createdAt: issued, updatedAt: issued }
}

describe('workspace prompt references', () => {
  it('matches model and provider words while leaving bare and single-letter @ for files and chats', () => {
    const models = [
      { connection: { connectionId: 'claude', label: 'Claude', harnessKind: 'claude' }, id: 'opus-4', label: 'Claude Opus 4' },
      { connection: { connectionId: 'codex', label: 'Codex', harnessKind: 'codex' }, id: 'gpt-6', label: 'GPT 6' },
    ]
    expect(searchMentionModels(models, '')).toEqual([])
    expect(searchMentionModels(models, 'c')).toEqual([])
    expect(searchMentionModels(models, 'opus:claude')).toEqual([
      { kind: 'model', path: 'model:claude/opus-4', label: 'Claude Opus 4', description: 'Claude' },
    ])
    expect(searchMentionModels(models, 'gpt-codex')[0]?.path).toBe('model:codex/gpt-6')
    expect(searchMentionModels(models, 'opt')).toEqual([])
  })

  it('searches titles with fuzzy fallback, excludes the current chat and favors recent matches', () => {
    expect(searchMentionTasks([task('current', 'Review composer'), task('other', 'Review composer'), task('unrelated')], 'rvw', 'current'))
      .toEqual([{ kind: 'conversation', path: 'other', label: 'Review composer', description: 'Chat context' }])
    expect(searchMentionTasks([{ ...task('archived'), archivedAt: issued }], '')).toEqual([])
  })

  it('indexes every project and task page before matching an older chat title', async () => {
    const calls: string[] = []
    const store = {
      listProjects: (options: { afterId?: string }) => Effect.sync(() => {
        calls.push(`projects:${options.afterId ?? ''}`)
        return { items: [{ id: projectIdSchema.make(options.afterId ? 'project-b' : 'project-a') }], nextAfterId: options.afterId ? null : 'project-a' }
      }),
      listTasks: (id: string, options: { afterId?: string }) => Effect.sync(() => {
        calls.push(`${id}:${options.afterId ?? ''}`)
        return { items: [task(options.afterId ? 'target' : id, options.afterId ? 'Older matching chat' : 'Other')], nextAfterId: !options.afterId && id === 'project-b' ? 'next' : null }
      }),
    } as unknown as WorkspaceStore['Service']
    const index = createPromptReferenceIndex(store)
    expect((await Effect.runPromise(index.search('older')))[0]?.path).toBe('target')
    await Effect.runPromise(index.search('matching'))
    expect(calls).toEqual(['projects:', 'project-a:', 'projects:project-a', 'project-b:', 'project-b:next'])
  })

  it('stores immutable chat context as a file link and pins later pages to the original watermark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-references-'))
    directories.push(directory)
    const files = createPromptReferenceFiles(directory)
    const watermarks: Array<number | undefined> = []
    const sourceTask = task('source', 'Review old changes')
    const conversationId = conversationIdSchema.make('conversation')
    const item: WorkspaceConversationPageItem = {
      event: { sequence: 1, schemaVersion: 1, kind: 'driverEvent', runId: agentRunIdSchema.make('run'), taskId: sourceTask.id, generation: 1, occurredAt: issued, data: { event: { kind: 'textDelta', text: 'Original reply' } } },
      userMessage: { id: 'message', content: 'Original question', createdAt: issued },
    }
    const store = {
      readTaskDetail: () => Effect.succeed({ task: sourceTask, conversations: [{ id: conversationId }], nextAfterConversationId: null }),
      readConversationPage: (_id: string, after: number, _limit: number, watermark?: number) => Effect.sync(() => {
        watermarks.push(watermark)
        return { items: after === 0 ? [item] : [], highWatermark: 2, hasMore: after === 0, nextAfterSequence: after === 0 ? 1 : null }
      }),
    } as unknown as WorkspaceStore['Service']
    const result = await Effect.runPromise(files.conversation(store, sourceTask.id))
    const [token] = collectPromptInlineTokens(result.text)
    expect(token.type).toBe('mention')
    expect(result.text).not.toContain('Original question')
    const snapshot = await readFile(token.value, 'utf8')
    expect(snapshot).toContain('Original question')
    expect(snapshot).toContain('Original reply')
    expect(watermarks).toEqual([undefined, 2])
    expect(await Effect.runPromise(files.conversation(store, sourceTask.id))).toEqual(result)
  })
})
