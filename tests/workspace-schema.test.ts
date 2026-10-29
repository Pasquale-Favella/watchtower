import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  agentSessionSchema,
  conversationSchema,
  projectSchema,
  taskSchema,
  workspaceCheckoutSchema,
} from '../src/shared/schemas/workspace.js'

describe('agent workspace domain schemas', () => {
  it('validates repository identity and explicit checkout identity independently of display names', () => {
    const project = {
      id: 'project-1',
      name: 'same-name',
      repositoryIdentity: 'repo:8c9150',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:00:00Z',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(projectSchema)(project))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, repositoryIdentity: '' }))).toBe(
      true,
    )
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, id: '  ' }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, createdAt: 'yesterday' }))).toBe(
      true,
    )

    const checkout = {
      id: 'checkout-main',
      projectId: project.id,
      kind: 'main',
      path: 'C:/work/repo',
      createdAt: project.createdAt,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(workspaceCheckoutSchema)(checkout))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(workspaceCheckoutSchema)({ ...checkout, path: '' }))).toBe(true)
  })

  it('keeps task lifecycle separate from conversations and native sessions', () => {
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      title: 'Implement feature',
      description: 'A durable objective',
      status: 'inReview',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:01:00Z',
    }
    const conversation = {
      id: 'conversation-1',
      taskId: task.id,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(taskSchema)(task))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(conversationSchema)(conversation))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(conversationSchema)({ ...conversation, taskId: '' }))).toBe(true)
  })

  it('requires native identity and positive generation for a persisted session', () => {
    const session = {
      id: 'session-1',
      taskId: 'task-1',
      conversationId: 'conversation-1',
      checkoutId: 'checkout-1',
      connectionId: 'codex-local',
      driverId: 'codex-app-server',
      nativeSessionId: 'native-77',
      generation: 2,
      status: 'active',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:01:00Z',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentSessionSchema)(session))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(agentSessionSchema)({ ...session, generation: 0 }))).toBe(true)
  })
})
