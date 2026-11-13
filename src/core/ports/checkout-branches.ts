import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  CheckoutBranches as CheckoutBranchList,
  CheckoutResolverError,
  SwitchBranchRequest,
} from '@/shared/schemas/checkout.js'

/** Local branches of a checkout, and switching the branch a checkout has checked out. */
export class CheckoutBranches extends Context.Service<
  CheckoutBranches,
  {
    readonly list: (checkoutPath: string) => Effect.Effect<CheckoutBranchList, CheckoutResolverError>
    /** Git refuses a switch that would lose uncommitted work or check one branch out twice. */
    readonly switchBranch: (request: SwitchBranchRequest) => Effect.Effect<CheckoutBranchList, CheckoutResolverError>
  }
>()('watchtower/core/CheckoutBranches') {}
