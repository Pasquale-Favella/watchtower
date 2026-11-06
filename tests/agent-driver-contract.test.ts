import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { AgentDriverError, UnsupportedAgentOperation } from '../src/core/ports/agent-driver.js'
import {
  agentCapabilitiesSchema,
  agentDriverEventSchema,
  agentRequestDecisionSchema,
  agentRequestSchema,
} from '../src/shared/schemas/execution.js'

describe('agent driver contract', () => {
  it('represents unknown capability support without promising a feature', () => {
    const capability = { support: 'unknown', restrictions: [], evidence: [{ source: 'unknown' }] }
    const capabilities = {
      openSession: capability,
      loadSession: capability,
      submit: { support: 'supported', restrictions: [], evidence: [{ source: 'protocol', detail: 'turn submission' }] },
      interrupt: capability,
      steer: {
        support: 'unsupported',
        restrictions: ['adapter has no steering operation'],
        evidence: [{ source: 'driver' }],
      },
      respond: capability,
      reconcile: capability,
      models: [],
      modes: [],
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentCapabilitiesSchema)(capabilities))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(agentCapabilitiesSchema)({ ...capabilities, steer: { support: 'maybe' } }),
      ),
    ).toBe(true)
  })

  it('retains native question option identities and supports cancel or structured answers', () => {
    const request = {
      requestId: 'request-1',
      runId: 'run-1',
      sessionId: 'session-1',
      generation: 4,
      kind: 'question',
      prompt: 'Choose a package manager',
      options: [{ id: 'allow-once-native', label: 'Allow once', scope: 'once', kind: 'allow' }],
      questions: [
        {
          id: 'package-manager',
          prompt: 'Which should I use?',
          multiSelect: false,
          options: [
            { id: 'pnpm-native-id', label: 'pnpm' },
            { id: 'npm-native-id', label: 'npm' },
          ],
        },
      ],
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentRequestSchema)(request))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(agentRequestDecisionSchema)({
          kind: 'answers',
          answers: { 'package-manager': 'pnpm-native-id' },
        }),
      ),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentRequestDecisionSchema)({ kind: 'cancel' }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(agentRequestDecisionSchema)({ kind: 'allow' }))).toBe(true)
  })

  it('distinguishes interrupted turns, stream completion events, and usage accounting semantics', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentDriverEventSchema)({ kind: 'turnStarted' }))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentDriverEventSchema)({ kind: 'turnInterrupted' }))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(agentDriverEventSchema)({
          kind: 'usageReported',
          semantics: 'cumulative',
          scope: 'session',
          revision: 'usage-r2',
          resetId: 'window-1',
          inputTokens: 12,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(agentDriverEventSchema)({
          kind: 'usageReported',
          inputTokens: 12,
        }),
      ),
    ).toBe(true)
  })

  it('returns a typed unsupported operation and preserves uncertain native outcomes', async () => {
    const unsupported = await Effect.runPromise(
      Effect.fail(
        new UnsupportedAgentOperation({
          operation: 'steer',
          message: 'driver does not expose steering',
        }),
      ).pipe(Effect.flip),
    )
    expect(unsupported.operation).toBe('steer')
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(UnsupportedAgentOperation)({
          _tag: 'UnsupportedAgentOperation',
          operation: 'restart',
          message: 'not supported',
        }),
      ),
    ).toBe(true)

    const uncertain = new AgentDriverError({
      code: 'outcome-uncertain',
      message: 'native acceptance could not be established',
    })
    expect(Result.isSuccess(Schema.decodeUnknownResult(AgentDriverError)(uncertain))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(AgentDriverError)({
          _tag: 'AgentDriverError',
          code: 'finished-successfully',
          message: 'unrecognized result',
        }),
      ),
    ).toBe(true)
  })
})
