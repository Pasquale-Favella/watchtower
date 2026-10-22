import * as Layer from 'effect/Layer'
import * as Reactivity from 'effect/reactivity/Reactivity'

import { runtime } from '../renderer-runtime.js'

/** Authoritative ledger/config events invalidate each window's activated queries. */
export const invalidateAnalyticsAtom = runtime(Layer.empty).fn(() => Reactivity.invalidate(['ledger', 'pricing']))
