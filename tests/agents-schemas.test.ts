import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  coachEventEnvelopeSchema,
  coachEventSchema,
  coachHarnessRowSchema,
  coachInspectRequestSchema,
  coachInspectResultSchema,
  coachLoginTerminalResultSchema,
  coachOpenLoginTerminalRequestSchema,
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
      {
        kind: 'session',
        resumeCursor: 'cursor_1',
        models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
      },
      { kind: 'notice', message: 'continuing in a fresh session' },
      { kind: 'error', message: 'CLI not logged in' },
    ]
    for (const event of ok) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(coachEventSchema)(event)), JSON.stringify(event)).toBe(true)
    }
  })

  it('accepts agent-declared models/modes on the session event (progressive selection)', () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachEventSchema)({
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
        }),
      ),
    ).toBe(true)
    // A malformed models payload (missing currentModelId) is rejected.
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachEventSchema)({
          kind: 'session',
          resumeCursor: 'cursor_1',
          models: { availableModels: [{ modelId: 'opus', name: 'x' }] },
        }),
      ),
    ).toBe(false)
  })

  it('rejects a discriminant outside the union and a bad status state', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachEventSchema)({ kind: 'bogus', x: 1 }))).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachEventSchema)({ kind: 'status', state: 'paused' }))).toBe(
      false,
    )
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachEventSchema)({ kind: 'text', delta: 42 }))).toBe(false)
  })

  it('parses the runId-enveloped push channel', () => {
    const envelope = { runId: 'run-1', event: { kind: 'text', delta: 'hi' } }
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachEventEnvelopeSchema)(envelope))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachEventEnvelopeSchema)({ runId: 'run-1', event: { kind: 'nope' } }),
      ),
    ).toBe(false)
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(coachEventEnvelopeSchema)({ event: { kind: 'text', delta: 'hi' } })),
    ).toBe(false)
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
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunRequestSchema)(full))).toBe(true)
    // There is no workspacePath field anymore — a stray one is stripped, never
    // part of the parsed wire shape (the runner cannot read what the schema
    // does not carry).
    const withStray = Schema.decodeUnknownResult(coachRunRequestSchema)({ ...full, workspacePath: 'C:\\work\\project' })
    expect(Result.isSuccess(withStray)).toBe(true)
    if (Result.isSuccess(withStray)) expect('workspacePath' in withStray.success).toBe(false)
    const { modelId, modeId, scope, ...withoutSelection } = full
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunRequestSchema)(withoutSelection))).toBe(true)
    void modelId
    void modeId
    void scope
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(coachRunRequestSchema)({ harnessKind: 'claude', prompt: 'p' })),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunRequestSchema)({ prompt: 'p' }))).toBe(false)
    // A malformed scope (bad period) is rejected.
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachRunRequestSchema)({
          harnessKind: 'claude',
          prompt: 'p',
          scope: { period: 'decade' },
        }),
      ),
    ).toBe(false)
  })

  it('strips a stray mode or evidence field (the single-coach wire carries neither)', () => {
    // Unknown keys are stripped — a build-skill request smuggling
    // mode/evidence is accepted, but those fields never reach the runner: the
    // channel is one coach prompt (same pattern as the stray workspacePath
    // above).
    const withMode = Schema.decodeUnknownResult(coachRunRequestSchema)({
      harnessKind: 'claude',
      prompt: 'p',
      mode: 'build-skill',
    })
    expect(Result.isSuccess(withMode)).toBe(true)
    if (Result.isSuccess(withMode)) expect('mode' in withMode.success).toBe(false)
    const withEvidence = Schema.decodeUnknownResult(coachRunRequestSchema)({
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
    expect(Result.isSuccess(withEvidence)).toBe(true)
    if (Result.isSuccess(withEvidence)) expect('evidence' in withEvidence.success).toBe(false)
  })

  it('parses the API-key passthrough opt-in on the run request (absent = stored-login default)', () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachRunRequestSchema)({ harnessKind: 'claude', prompt: 'p', allowApiKeyEnv: true }),
      ),
    ).toBe(true)
    const without = Schema.decodeUnknownResult(coachRunRequestSchema)({ harnessKind: 'claude', prompt: 'p' })
    expect(Result.isSuccess(without)).toBe(true)
    if (Result.isSuccess(without)) expect('allowApiKeyEnv' in without.success).toBe(false)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachRunRequestSchema)({
          harnessKind: 'claude',
          prompt: 'p',
          allowApiKeyEnv: 'yes',
        }),
      ),
    ).toBe(false)
  })

  it('parses the inspect request as a bare key or key-plus-passthrough', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)('claude'))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)({ kind: 'claude' }))).toBe(true)
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)({ kind: 'claude', allowApiKeyEnv: true })),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)(''))).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)({ kind: '' }))).toBe(false)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachInspectRequestSchema)({ kind: 'claude', allowApiKeyEnv: 'yes' }),
      ),
    ).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectRequestSchema)(42))).toBe(false)
  })

  it('parses both ack arms of the run result', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunResultSchema)({ ok: true, runId: 'run-1' }))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachRunResultSchema)({ ok: false, error: 'harness not detected: ghost' }),
      ),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunResultSchema)({ ok: true }))).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachRunResultSchema)({ ok: 'maybe' }))).toBe(false)
  })

  it('parses a harness picker row (no static model list — map 47 ticket 49)', () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachHarnessRowSchema)({
          instanceId: 'claude',
          kind: 'claude',
          displayName: 'Claude Code',
          status: 'ready',
          auth: { status: 'configured' },
        }),
      ),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachHarnessRowSchema)({ kind: 'claude' }))).toBe(false)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachHarnessRowSchema)({
          instanceId: 'claude',
          kind: 'claude',
          displayName: 'x',
          status: 'ready',
          auth: { status: 'nope' },
        }),
      ),
    ).toBe(false)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachHarnessRowSchema)({
          instanceId: 'codex',
          kind: 'codex',
          displayName: 'Codex',
          status: 'warning',
          auth: { status: 'unauthenticated', loginCommand: 'codex login' },
          message: 'Sign in',
        }),
      ),
    ).toBe(true)
  })

  it('parses the login-terminal request and result arms', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachOpenLoginTerminalRequestSchema)('codex'))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachOpenLoginTerminalRequestSchema)(''))).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachLoginTerminalResultSchema)({ ok: true }))).toBe(true)
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(coachLoginTerminalResultSchema)({ ok: false, error: 'not found' })),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachLoginTerminalResultSchema)({ ok: false }))).toBe(false)
  })

  it('parses the pre-flight inspect result — models/modes optional, probe failure as ok:false (map 47 ticket 50)', () => {
    const models = { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' }
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectResultSchema)({ ok: true, models }))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachInspectResultSchema)({
          ok: true,
          models,
          modes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' },
        }),
      ),
    ).toBe(true)
    // No declared set — the pickers simply stay absent.
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectResultSchema)({ ok: true }))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachInspectResultSchema)({ ok: false, error: 'agent binary not found' }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(coachInspectResultSchema)({ ok: true, models: { availableModels: [] } }),
      ),
    ).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(coachInspectResultSchema)({ ok: 'maybe' }))).toBe(false)
  })
})
