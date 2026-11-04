import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { CheckoutActionError, CheckoutGitStatus } from '@/shared/schemas/workspace-checkout-actions.js'

export class CheckoutActions extends Context.Service<
  CheckoutActions,
  {
    readonly status: (root: string) => Effect.Effect<CheckoutGitStatus, CheckoutActionError>
    readonly stage: (root: string, paths: readonly string[]) => Effect.Effect<void, CheckoutActionError>
    readonly unstage: (root: string, paths: readonly string[]) => Effect.Effect<void, CheckoutActionError>
    readonly commit: (
      root: string,
      message: string,
    ) => Effect.Effect<{ readonly revision: string }, CheckoutActionError>
  }
>()('watchtower/CheckoutActions') {}
