import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { coachDetection } from '@/renderer/features/coach-skills/atoms'
import { compareQuery } from '@/renderer/features/compare/atoms'
import { modelsQuery } from '@/renderer/features/models/atoms'
import { pricingKnownModelsQuery } from '@/renderer/features/models/pricing-atoms'
import { optimizeQuery, yieldQuery } from '@/renderer/features/optimize/atoms'
import { overviewQuery } from '@/renderer/features/overview/atoms'
import { pullRequestsQuery } from '@/renderer/features/pull-requests/atoms'
import { sessionQuery, sessionRowsQuery } from '@/renderer/features/sessions/atoms'
import { spendQuery } from '@/renderer/features/spend/atoms'

import { restartRpcQuery } from '@/renderer/stores/atoms/rpc-query.js'
import { searchSlot } from '@/renderer/stores/atoms/search.js'

/** Called only after a successful clear. Configuration and conversation state survive. */
export function resetLedgerQueries(registry: AtomRegistry.AtomRegistry): void {
  Atom.batch(() => {
    restartRpcQuery(registry, overviewQuery)
    restartRpcQuery(registry, sessionRowsQuery)
    restartRpcQuery(registry, sessionQuery)
    restartRpcQuery(registry, spendQuery)
    restartRpcQuery(registry, modelsQuery)
    restartRpcQuery(registry, pricingKnownModelsQuery)
    restartRpcQuery(registry, pullRequestsQuery)
    restartRpcQuery(registry, compareQuery)
    restartRpcQuery(registry, optimizeQuery)
    restartRpcQuery(registry, yieldQuery)
    restartRpcQuery(registry, coachDetection)
    restartRpcQuery(registry, searchSlot)
  })
}
