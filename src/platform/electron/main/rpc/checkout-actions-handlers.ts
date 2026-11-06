import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { CheckoutActions } from '@/core/ports/checkout-actions.js'
import { CheckoutActionError, checkoutActionMessages, CheckoutActionsRpcGroup } from '@/shared/rpc/checkout-actions.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

export function checkoutActionsHandlers<R>(options: {
  readonly resolveCheckoutPath: (scope: CheckoutScope) => Effect.Effect<string, unknown, R>
}) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const actions = yield* CheckoutActions
      const root = (scope: CheckoutScope) =>
        options
          .resolveCheckoutPath(scope)
          .pipe(
            Effect.mapError(
              () => new CheckoutActionError({ code: 'unavailable', message: checkoutActionMessages.unavailable }),
            ),
          )
      return CheckoutActionsRpcGroup.toLayer({
        'checkout:gitStatus': request => Effect.flatMap(root(request), actions.status),
        'checkout:stage': request => Effect.flatMap(root(request), path => actions.stage(path, request.paths)),
        'checkout:unstage': request => Effect.flatMap(root(request), path => actions.unstage(path, request.paths)),
        'checkout:commit': request => Effect.flatMap(root(request), path => actions.commit(path, request.message)),
      })
    }),
  )
}
