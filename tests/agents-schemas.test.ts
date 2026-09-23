import { describe, expect, it } from 'vitest'

import {
  coachEventEnvelopeSchema,
  coachEventSchema,
  coachHarnessRowSchema,
  coachLoginTerminalResultSchema,
  coachOpenLoginTerminalRequestSchema,
  coachInspectRequestSchema,
  coachInspectResultSchema,
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
      { kind: 'reasoning', delta: 'thinking…' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'tool', tool: 'Edit', title: 'Read package.json' },
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started' },
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'completed', input: '{"command":"ls"}', output: 'total 0' },
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'error', error: 'timeout' },
      { kind: 'session', resumeCursor: 'cursor_1' },
      { kind: 'session', resumeCursor: 'cursor_1', models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' } },
      { kind: 'notice', message: 'continuing in a fresh session' },
      { kind: 'error', message: 'CLI not logged in' },
    ]
    for (const event of ok) {
      expect(coachEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('accepts agent-declared models/modes on the session event (progressive selection)', () => {
    expect(coachEventSchema.safeParse({
      kind: 'session',
      resumeCursor: 'cursor_1',
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
      resumeCursor: 'cursor_1',
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
      resumeCursor: 'cursor_1',
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

  it('strips a stray mode or evidence field (the single-coach wire carries neither)', () => {
    // Zod strips unknown keys (non-strict) — a build-skill request smuggling
    // mode/evidence is accepted, but those fields never reach the runner: the
    // channel is one coach prompt (same pattern as the stray workspacePath
    // above).
    const withMode = coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p', mode: 'build-skill' })
    expect(withMode.success).toBe(true)
    if (withMode.success) expect('mode' in withMode.data).toBe(false)
    const withEvidence = coachRunRequestSchema.safeParse({
      harnessKind: 'claude',
      prompt: 'p',
      evidence: {
        source: 'bash',
        name: 'git commit',
        frequency: 6,
        spreadSessions: 2,
        spreadProjects: 1,
        costUSD: 3.5,
        turns: 4,
      },
    })
    expect(withEvidence.success).toBe(true)
    if (withEvidence.success) expect('evidence' in withEvidence.data).toBe(false)
  })

  it('parses the API-key passthrough opt-in on the run request (absent = stored-login default)', () => {
    expect(coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p', allowApiKeyEnv: true }).success).toBe(true)
    const without = coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p' })
    expect(without.success).toBe(true)
    if (without.success) expect('allowApiKeyEnv' in without.data).toBe(false)
    expect(coachRunRequestSchema.safeParse({ harnessKind: 'claude', prompt: 'p', allowApiKeyEnv: 'yes' }).success).toBe(false)
  })

  it('parses the inspect request as a bare key or key-plus-passthrough', () => {
    expect(coachInspectRequestSchema.safeParse('claude').success).toBe(true)
    expect(coachInspectRequestSchema.safeParse({ kind: 'claude' }).success).toBe(true)
    expect(coachInspectRequestSchema.safeParse({ kind: 'claude', allowApiKeyEnv: true }).success).toBe(true)
    expect(coachInspectRequestSchema.safeParse('').success).toBe(false)
    expect(coachInspectRequestSchema.safeParse({ kind: '' }).success).toBe(false)
    expect(coachInspectRequestSchema.safeParse({ kind: 'claude', allowApiKeyEnv: 'yes' }).success).toBe(false)
    expect(coachInspectRequestSchema.safeParse(42).success).toBe(false)
  })

  it('parses both ack arms of the run result', () => {
    expect(coachRunResultSchema.safeParse({ ok: true, runId: 'run-1' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: false, error: 'harness not detected: ghost' }).success).toBe(true)
    expect(coachRunResultSchema.safeParse({ ok: true }).success).toBe(false)
    expect(coachRunResultSchema.safeParse({ ok: 'maybe' }).success).toBe(false)
  })

  it('parses a harness picker row (no static model list — map 47 ticket 49)', () => {
    expect(coachHarnessRowSchema.safeParse({
      instanceId: 'claude',
      kind: 'claude',
      displayName: 'Claude Code',
      status: 'ready',
      auth: { status: 'configured' },
    }).success).toBe(true)
    expect(coachHarnessRowSchema.safeParse({ kind: 'claude' }).success).toBe(false)
    expect(coachHarnessRowSchema.safeParse({
      instanceId: 'claude', kind: 'claude', displayName: 'x', status: 'ready', auth: { status: 'nope' },
    }).success).toBe(false)
    expect(coachHarnessRowSchema.safeParse({
      instanceId: 'codex', kind: 'codex', displayName: 'Codex', status: 'warning',
      auth: { status: 'unauthenticated', loginCommand: 'codex login' }, message: 'Sign in',
    }).success).toBe(true)
  })

  it('parses the login-terminal request and result arms', () => {
    expect(coachOpenLoginTerminalRequestSchema.safeParse('codex').success).toBe(true)
    expect(coachOpenLoginTerminalRequestSchema.safeParse('').success).toBe(false)
    expect(coachLoginTerminalResultSchema.safeParse({ ok: true }).success).toBe(true)
    expect(coachLoginTerminalResultSchema.safeParse({ ok: false, error: 'not found' }).success).toBe(true)
    expect(coachLoginTerminalResultSchema.safeParse({ ok: false }).success).toBe(false)
  })

  it('parses the pre-flight inspect result — models/modes optional, probe failure as ok:false (map 47 ticket 50)', () => {
    const models = { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' }
    expect(coachInspectResultSchema.safeParse({ ok: true, models }).success).toBe(true)
    expect(coachInspectResultSchema.safeParse({ ok: true, models, modes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' } }).success).toBe(true)
    // No declared set — the pickers simply stay absent.
    expect(coachInspectResultSchema.safeParse({ ok: true }).success).toBe(true)
    expect(coachInspectResultSchema.safeParse({ ok: false, error: 'agent binary not found' }).success).toBe(true)
    expect(coachInspectResultSchema.safeParse({ ok: true, models: { availableModels: [] } }).success).toBe(false)
    expect(coachInspectResultSchema.safeParse({ ok: 'maybe' }).success).toBe(false)
  })

})
