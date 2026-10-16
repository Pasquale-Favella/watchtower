import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type SearchHit, searchHitSchema } from '../../shared/schemas/views.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import { searchSessionsFromData } from '../session-search-calculation.js'
import { LedgerSessionReads } from '../store/ledger-session-reads.js'

export const querySessionSearch = Effect.fn('querySessionSearch')(function* (input: {
  readonly catalogue: PricingCatalogue
  readonly query: string
}): Effect.fn.Return<SearchHit[], SqlError | Schema.SchemaError, LedgerSessionReads> {
  const term = input.query.trim()
  if (!term) return []
  const reads = yield* LedgerSessionReads
  const data = yield* reads.getSessionSearchData()
  return yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(searchHitSchema)))(
    searchSessionsFromData(data, term, input.catalogue),
  )
})
