import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { isSqliteBusyError } from '../src/main/pipeline/sqlite.js'

class ProviderReadError extends Schema.TaggedError<ProviderReadError>()('ProviderReadError', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

describe('SQLite contention classification', () => {
  it.each([
    { code: 'SQLITE_BUSY' },
    { code: 'SQLITE_LOCKED' },
    { errcode: 5 },
    { errcode: 6 },
    { message: 'SQLITE_BUSY: operation failed' },
    { message: 'database is locked' },
    { errstr: 'database table is locked' },
  ])('recognizes native contention metadata %j', error => {
    expect(isSqliteBusyError(error)).toBe(true)
  })

  it('recognizes a code-only native cause through a typed provider failure', async () => {
    const native = Object.assign(new Error('read unavailable'), { code: 'SQLITE_BUSY' })
    const typed = new ProviderReadError({ cause: native, message: 'provider read failed' })
    const rejection = await Effect.runPromise(Effect.fail(typed)).catch(error => error)
    expect(rejection).toBe(typed)
    expect(isSqliteBusyError(rejection)).toBe(true)
  })

  it('recognizes nested native causes without changing the original error', () => {
    const native = { errcode: 6, message: 'query failed' }
    const error = new Error('outer failure', { cause: new Error('inner failure', { cause: native }) })
    expect(isSqliteBusyError(error)).toBe(true)
    expect((error.cause as Error).cause).toBe(native)
  })

  it.each([undefined, null, 5, 'SQLITE_BUSY', {}, { code: 'SQLITE_ERROR' }, new Error('schema missing')])(
    'rejects non-contention values %j',
    error => {
      expect(isSqliteBusyError(error)).toBe(false)
    },
  )

  it('terminates on a cyclic non-contention cause', () => {
    const error = new Error('schema missing')
    error.cause = error
    expect(isSqliteBusyError(error)).toBe(false)
  })
})
