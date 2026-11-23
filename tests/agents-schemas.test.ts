import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { coachHarnessRowSchema } from '../src/shared/schemas/agents.js'

describe('Harness status wire contract — frozen shared schemas', () => {
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
})
