import { describe, expect, it } from 'vitest'

import {
  coachEventEnvelopeSchema,
  coachEventSchema,
  coachHarnessRowSchema,
  coachModeSchema,
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
      { kind: 'session', sessionId: 'sess_1', models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' } },
      { kind: 'error', message: 'CLI not logged in' },
    ]
    for (const event of ok) {
      expect(coachEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('accepts agent-declared models/modes on the session event (progressive selection)', () => {
    expect(coachEventSchema.safeParse({
      kind: 'session',
      sessionId: 'sess_1',
      models: {
        availableModels: [
          { modelId: 'opus', name: 'Claude Opus' },
          { modelId: 'sonnet', name: 'Claude Sonnet', description: 'Fast' },
        ],
        currentModelId: 'opus',
      },
      modes: {
        availableModes: [{ id: 'plan', name: 'Plan' }],
        currentModeId: 'plan',
      },
    }).success).toBe(true)
    // A malformed models payload (missing currentModelId) is rejected.
    expect(coachEventSchema.safeParse({
      kind: 'session',
      sessionId: 'sess_1',
      models: { availableModels: [{ modelId: 'opus', name: 'x' }] },
    }).success).toBe(false)
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

  it('parses a valid run request with no workspace path (map 53) and optional modelId/modeId/scope', () => {
    const full = {
      harnessKind: 'claude',
      modelId: 'claude-opus-4-8',
      modeId: 'plan',
      scope: { period: '30days', provider: 'claude' },
      prompt: 'Summarise my spend',
      sessionId: 'sess_1',
    }
    expect(coachRunRequestSchema.safeParse(full).success).toBe(true)
    // There is no workspacePath field anymore — a stray one is stripped, never
    // part of the parsed wire shape (the runner cannot read what the schema
    // does not carry).
    const withStray = coachRunRequestSchema.safeParse({ ...full, workspacePath: 'C:\\work\\project' })
    expect(withStray.success).toBe(true)
    if (withStray.success) expect('workspacePath' in withStray.data).toBe(false)
    const { modelId, modeId, scope, ...withoutSelection } = full
    expect(coachRunRequestSchema.safeParse(withoutSelection).success).toBe(true)
    void modelId
    void modeId
    void scope
    expect(coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p' }).success).toBe(true)
    expect(coachRunRequestSchema.safeParse({ prompt: 'p' }).success).toBe(false)
    // A malformed scope (bad period) is rejected.
    expect(coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p', scope: { period: 'decade' } }).success).toBe(false)
  })

  it('defaults mode to coach and accepts a build-skill evidence payload', () => {
    const parsed = coachRunRequestSchema.safeParse({
      harnessKind: 'claude',
      prompt: 'p',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mode).toBe('coach')
    expect(coachRunRequestSchema.safeParse({
      harnessKind: 'claude',
      mode: 'build-skill',
      evidence: {
        source: 'bash',
        name: 'git commit',
        frequency: 6,
        spreadSessions: 2,
        spreadProjects: 1,
        costUSD: 3.5,
        turns: 4,
      },
    }).success).toBe(true)
  })

  it('keeps evidence optional at the schema (the runner enforces build-skill needs it) and rejects an unknown mode', () => {
    // The wire keeps evidence optional so the channel stays uniform; the
    // runner's semantic check refuses a build-skill run without evidence.
    expect(coachRunRequestSchema.safeParse({
      harnessKind: 'claude',
      mode: 'build-skill',
    }).success).toBe(true)
    expect(coachRunRequestSchema.safeParse({
      harnessKind: 'claude',
      mode: 'roast',
    }).success).toBe(false)
  })

  it('parses the mode enum', () => {
    expect(coachModeSchema.safeParse('coach').success).toBe(true)
    expect(coachModeSchema.safeParse('build-skill').success).toBe(true)
    expect(coachModeSchema.safeParse('nope').success).toBe(false)
  })

  it('parses both ack arms of the run result', () => {
    expect(coachRunResultSchema.safeParse({ ok: true, runId: 'run-1' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: false, error: 'harness not detected: ghost' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: true }).success).toBe(false)
    expect(coachRunResultSchema.safeParse({ ok: 'maybe' }).success).toBe(false)
  })

  it('parses a harness picker row (no static model list — map 47 ticket 49)', () => {
    expect(coachHarnessRowSchema.safeParse({
      kind: 'claude',
      displayName: 'Claude Code',
      authStatus: 'configured',
    }).success).toBe(true)
    expect(coachHarnessRowSchema.safeParse({ kind: 'claude' }).success).toBe(false)
    expect(coachHarnessRowSchema.safeParse({ kind: 'claude', displayName: 'x', authStatus: 'nope' }).success).toBe(false)
  })

})
