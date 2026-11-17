import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { CheckoutInspection, CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import {
  CheckoutInspectionRpcError,
  CheckoutInspectionRpcGroup,
  checkoutInspectionRpcMessages,
} from '@/shared/rpc/checkout-inspection.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

function failure(code: CheckoutInspectionRpcError['code']): CheckoutInspectionRpcError {
  return new CheckoutInspectionRpcError({ code, message: checkoutInspectionRpcMessages[code] })
}

/** Core diagnostics stay in the operational log. Only fixed messages cross the RPC boundary. */
function sanitize(error: unknown): CheckoutInspectionRpcError {
  if (Schema.is(CheckoutInspectionRpcError)(error)) return error
  if (Schema.is(CheckoutInspectionError)(error)) return failure(error.code)
  return failure('failed')
}

function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CheckoutInspectionRpcError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const found = Cause.findError(cause)
      return Effect.fail(found._tag === 'Success' ? sanitize(found.success) : failure('failed'))
    }),
  )
}

export interface CheckoutInspectionHandlerOptions<R = never> {
  /**
   * Maps a Project and optional checkout to its canonical path. The renderer never supplies a filesystem path.
   * The resolver may require the workspace store, which the composition root already provides.
   */
  readonly resolveCheckoutPath: (request: CheckoutScope) => Effect.Effect<string, CheckoutInspectionRpcError, R>
}

/** Checkout review and text editing handlers. They require the CheckoutInspection service from the caller's runtime. */
export function checkoutInspectionHandlers<R = never>(options: CheckoutInspectionHandlerOptions<R>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const inspection = yield* CheckoutInspection
      const checkout = <A>(request: CheckoutScope, use: (root: string) => Effect.Effect<A, CheckoutInspectionError>) =>
        safe(options.resolveCheckoutPath(request).pipe(Effect.flatMap(use)))
      return CheckoutInspectionRpcGroup.toLayer({
        'checkout:diffPreview': request => checkout(request, root => inspection.diffPreview(root, request.source)),
        'checkout:filePatch': request =>
          checkout(request, root =>
            inspection.filePatch(root, {
              source: request.source,
              path: request.path,
              previousPath: request.previousPath,
              includeContents: request.includeContents,
              contextLines: request.contextLines,
            }),
          ),
        'checkout:branches': request => checkout(request, root => inspection.branches(root)),
        'checkout:commits': request => checkout(request, root => inspection.commits(root)),
        'checkout:listEntries': request =>
          checkout(request, root => inspection.listEntries(root, request.path, request)),
        'checkout:readFile': request => checkout(request, root => inspection.readFile(root, request.path, request)),
        'checkout:writeFile': request => checkout(request, root => inspection.writeFile(root, request)),
      })
    }),
  )
}
