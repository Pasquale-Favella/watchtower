import { describe, expect, it } from 'vitest'

import {
  agentsConsentResultSchema,
  coachEventEnvelopeSchema,
  coachEventSchema,
  coachHarnessRowSchema,
  coachRunRequestSchema,
  coachRunResultSchema,
} from '../src/shared/schemas/agents.js'

describe('Coach wire contract (ticket 21, ADR 0005) — frozen shared schemas', () => {
  it('parses every CoachEvent discriminant', () => {
    const ok: unknown[] = [
      { kind: 'status', state: 'starting' },
      { kind: 'status', state: 'running' },
      { kind: 'status', state: 'done' },
      { kind: 'text', delta: 'hi' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'tool', tool: 'Edit', title: 'Read package.json' },
      { kind: 'session', sessionId: 'sess_1' },
      { kind: 'error', message: 'CLI not logged in' },
    ]
    for (const event of ok) {
      expect(coachEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('rejects a discriminant outside the union and a bad status state', () => {
    expect(coachEventSchema.safeParse({ kind: 'bogus', x: 1 }).success).toBe(false)
    expect(coachEventSchema.safeParse({ kind: 'status', state: 'paused' }).success).toBe(false)
    expect(coachEventSchema.safeParse({ kind: 'text', delta: 42 }).success).toBe(false)
  })

  it('parses the runId-enveloped push channel', () => {
    const envelope = { runId: 'run-1', event: { kind: 'text', delta: 'hi' } }
    expect(coachEventEnvelopeSchema.safeParse(envelope).success).toBe(true)
    expect(coachEventEnvelopeSchema.safeParse({ runId: 'run-1', event: { kind: 'nope' } }).success).toBe(false)
    expect(coachEventEnvelopeSchema.safeParse({ event: { kind: 'text', delta: 'hi' } }).success).toBe(false)
  })

  it('parses a valid run request and treats model as optional', () => {
    const full = {
      harnessKind: 'claude',
      model: 'claude-opus-4-8',
      workspacePath: 'C:\\work\\project',
      prompt: 'Summarise my spend',
      sessionId: 'sess_1',
    }
    expect(coachRunRequestSchema.safeParse(full).success).toBe(true)
    const { model, ...withoutModel } = full
    expect(coachRunRequestSchema.safeParse(withoutModel).success).toBe(true)
    void model
    expect(coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p' }).success).toBe(false)
  })

  it('parses both ack arms of the run result', () => {
    expect(coachRunResultSchema.safeParse({ ok: true, runId: 'run-1' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: false, error: 'harness not detected: ghost' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: true }).success).toBe(false)
    expect(coachRunResultSchema.safeParse({ ok: 'maybe' }).success).toBe(false)
  })

  it('parses a harness picker row', () => {
    expect(coachHarnessRowSchema.safeParse({
      kind: 'claude',
      displayName: 'Claude Code',
      models: ['claude-opus-4-8'],
      authStatus: 'configured',
    }).success).toBe(true)
    expect(coachHarnessRowSchema.safeParse({ kind: 'claude' }).success).toBe(false)
    expect(coachHarnessRowSchema.safeParse({ kind: 'claude', displayName: 'x', models: [], authStatus: 'nope' }).success).toBe(false)
  })

  it('parses the consent gate result (ticket 22, ADR 0012 addendum)', () => {
    expect(agentsConsentResultSchema.safeParse({ granted: true }).success).toBe(true)
    expect(agentsConsentResultSchema.safeParse({ granted: false }).success).toBe(true)
    expect(agentsConsentResultSchema.safeParse({ granted: 'yes' }).success).toBe(false)
    expect(agentsConsentResultSchema.safeParse({}).success).toBe(false)
  })
})
