import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { ledgerQueryRequest } from '../src/main/db-worker/query-dispatch.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const scope = { period: 'lifetime' }
const requests: Array<[string, unknown[]]> = [
  ['store:views', []],
  ['store:projects', []],
  ['store:sessions', []],
  ['sessions:view', [scope]],
  ['pullRequests:view', [scope]],
  ['spend:view', [scope]],
  ['models:view', [scope]],
  ['compare:view', [scope]],
  ['optimize:view', [scope]],
  ['skills:view', [scope]],
  ['optimize:yield', [scope]],
  ['store:session', ['missing-session']],
  ['store:analytics', []],
  ['overview:query', [scope]],
  ['store:search', ['']],
]

describe('worker query transport', () => {
  it.each(requests)('runs %s in the existing native worker runtime', async (operation, args) => {
    const fixture = openLedgerFixture()
    const query = ledgerQueryRequest(operation, args)
    expect(Effect.isEffect(query)).toBe(true)
    if (!query) throw new Error(`Missing query for ${operation}`)
    const result = await fixture.runtime.runPromise(query)
    if (operation === 'store:session') expect(result).toBeNull()
    else expect(result).toBeDefined()
  })

  it.each(['export:csv', 'export:json'])('%s avoids file access for an empty ledger', async operation => {
    const fixture = openLedgerFixture()
    const query = ledgerQueryRequest(operation, ['unused-destination'])
    expect(query).toBeDefined()
    if (!query) throw new Error(`Missing query for ${operation}`)
    expect(await fixture.runtime.runPromise(query)).toEqual({
      ok: false,
      error: 'no data to export yet — scan first',
    })
  })

  it.each(['scan:start', 'scan:abort', 'settings:clear', 'unknown'])('leaves %s with the supervisor', operation => {
    expect(ledgerQueryRequest(operation, [])).toBeUndefined()
  })
})
