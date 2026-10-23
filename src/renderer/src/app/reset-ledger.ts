import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { coachDetection } from '@/features/coach-skills/atoms'
import { compareQuery } from '@/features/compare/atoms'
import { modelsQuery } from '@/features/models/atoms'
import { pricingKnownModelsQuery } from '@/features/models/pricing-atoms'
import { optimizeQuery, yieldQuery } from '@/features/optimize/atoms'
import { overviewQuery } from '@/features/overview/atoms'
import { pullRequestsQuery } from '@/features/pull-requests/atoms'
import { sessionQuery, sessionRowsQuery } from '@/features/sessions/atoms'
import { spendQuery } from '@/features/spend/atoms'

import { restartRemoteQuery } from './atoms/remote-query.js'
import { searchSlot } from './atoms/search.js'

/** Called only after a successful clear. Configuration and conversation state survive. */
export function resetLedgerQueries(registry: AtomRegistry.AtomRegistry): void {
  Atom.batch(() => {
    restartRemoteQuery(registry, overviewQuery)
    restartRemoteQuery(registry, sessionRowsQuery)
    restartRemoteQuery(registry, sessionQuery)
    restartRemoteQuery(registry, spendQuery)
    restartRemoteQuery(registry, modelsQuery)
    restartRemoteQuery(registry, pricingKnownModelsQuery)
    restartRemoteQuery(registry, pullRequestsQuery)
    restartRemoteQuery(registry, compareQuery)
    restartRemoteQuery(registry, optimizeQuery)
    restartRemoteQuery(registry, yieldQuery)
    restartRemoteQuery(registry, coachDetection)
    restartRemoteQuery(registry, searchSlot)
  })
}
