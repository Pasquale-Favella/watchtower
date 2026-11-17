import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  CheckoutResolverError,
  CreateIsolatedWorktreeRequest,
  RemoveWorktreeRequest,
  ResolvedCheckout,
} from '@/shared/schemas/checkout.js'

export { CheckoutResolverError } from '@/shared/schemas/checkout.js'

/** Canonical checkout identity and Git-managed isolation, not a filesystem sandbox.
 * Mutation guards are enforced at admission; external writers remain advisory.
 */
export class CheckoutResolver extends Context.Service<
  CheckoutResolver,
  {
    readonly resolve: (path: string) => Effect.Effect<ResolvedCheckout, CheckoutResolverError>
    readonly createIsolatedWorktree: (
      request: CreateIsolatedWorktreeRequest,
    ) => Effect.Effect<ResolvedCheckout, CheckoutResolverError>
    readonly removeWorktree: (request: RemoveWorktreeRequest) => Effect.Effect<void, CheckoutResolverError>
  }
>()('watchtower/core/CheckoutResolver') {}
