import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  delegationToolCancelInputSchema,
  delegationToolReadInputSchema,
  delegationToolSendInputSchema,
  delegationToolStartInputSchema,
  delegationToolStatusInputSchema,
} from '@/shared/schemas/delegation-tools.js'

const decodeStart = (value: unknown) => Schema.decodeUnknownResult(delegationToolStartInputSchema)(value)

describe('orchestration tool inputs', () => {
  it('requires only the task text and defaults everything else', () => {
    const decoded = decodeStart({ task: 'Summarize the open issues' })
    expect(decoded._tag).toBe('Success')
    if (decoded._tag !== 'Success') return
    expect(decoded.success.task).toBe('Summarize the open issues')
    expect(decoded.success.mode).toBeUndefined()
    expect(decoded.success.target).toBeUndefined()
  })

  it('accepts a target as an object or as a JSON string with the same fields', () => {
    const asObject = decodeStart({ task: 'x', target: { connection: 'codex-1', model: 'gpt' } })
    const asString = decodeStart({ task: 'x', target: '{"connection":"codex-1","model":"gpt"}' })
    expect(asObject._tag).toBe('Success')
    expect(asString._tag).toBe('Success')
    if (asString._tag !== 'Success') return
    expect(asString.success.target).toEqual({ connection: 'codex-1', model: 'gpt' })
  })

  it('rejects an oversized task, an out-of-range wait timeout and an unknown mode', () => {
    expect(decodeStart({ task: 'x'.repeat(32 * 1024 + 1) })._tag).toBe('Failure')
    expect(decodeStart({ task: 'x', mode: 'wait', timeoutMs: 45_001 })._tag).toBe('Failure')
    expect(decodeStart({ task: 'x', timeoutMs: 0 })._tag).toBe('Failure')
    expect(decodeStart({ task: 'x', mode: 'poll' })._tag).toBe('Failure')
  })

  it('does not carry caller identity from arguments', () => {
    const decoded = decodeStart({ task: 'x', taskId: 'someone-else', runId: 'run-2' })
    expect(decoded._tag).toBe('Success')
    if (decoded._tag !== 'Success') return
    expect(decoded.success).not.toHaveProperty('taskId')
    expect(decoded.success).not.toHaveProperty('runId')
  })

  it('validates ids and the cancel reason', () => {
    expect(Schema.decodeUnknownResult(delegationToolStatusInputSchema)({ id: '' })._tag).toBe('Failure')
    expect(Schema.decodeUnknownResult(delegationToolStatusInputSchema)({ id: 'dlg-1' })._tag).toBe('Success')
    expect(
      Schema.decodeUnknownResult(delegationToolCancelInputSchema)({ id: 'dlg-1', reason: 'x'.repeat(501) })._tag,
    ).toBe('Failure')
    expect(Schema.decodeUnknownResult(delegationToolStatusInputSchema)({ limit: 51 })._tag).toBe('Failure')
    expect(Schema.decodeUnknownResult(delegationToolStatusInputSchema)({})._tag).toBe('Success')
    expect(Schema.decodeUnknownResult(delegationToolReadInputSchema)({ id: 'dlg-1', limit: 21 })._tag).toBe('Failure')
    expect(Schema.decodeUnknownResult(delegationToolSendInputSchema)({ id: 'dlg-1', message: ' ' })._tag).toBe(
      'Failure',
    )
    expect(
      Schema.decodeUnknownResult(delegationToolSendInputSchema)({
        id: 'dlg-1',
        message: 'Use v2',
        answers: { q1: 'yes' },
      })._tag,
    ).toBe('Success')
  })

  it('advertises the same contract as its decoder', () => {
    const advertised = Schema.toStandardJSONSchemaV1(delegationToolStartInputSchema)['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as {
      readonly required?: ReadonlyArray<string>
      readonly properties?: Record<string, { readonly enum?: unknown }>
    }
    expect(advertised.required).toContain('task')
    expect(advertised.required).not.toContain('mode')
    expect(advertised.properties?.['mode']?.enum).toEqual(['async', 'wait'])
  })
})
