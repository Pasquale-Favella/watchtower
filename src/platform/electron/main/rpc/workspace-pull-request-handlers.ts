import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { WorkspacePullRequestError, WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import {
  pullRequestRpcMessages,
  WorkspacePullRequestRpcError,
  WorkspacePullRequestRpcGroup,
} from '@/shared/rpc/workspace-pull-requests.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

function sanitize(error: unknown): WorkspacePullRequestRpcError {
  if (Schema.is(WorkspacePullRequestRpcError)(error)) return error
  const code = Schema.is(WorkspacePullRequestError)(error) ? error.code : 'failed'
  return new WorkspacePullRequestRpcError({ code, message: pullRequestRpcMessages[code] })
}

function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WorkspacePullRequestRpcError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const error = Cause.findError(cause)
      return Effect.fail(sanitize(error._tag === 'Success' ? error.success : undefined))
    }),
  )
}

export interface WorkspacePullRequestHandlerOptions<R = never> {
  readonly resolveCheckoutPath: (scope: CheckoutScope) => Effect.Effect<string, WorkspacePullRequestRpcError, R>
}

export function workspacePullRequestHandlers<R = never>(options: WorkspacePullRequestHandlerOptions<R>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* WorkspacePullRequests
      const checkout = <A>(
        request: CheckoutScope,
        use: (root: string) => Effect.Effect<A, WorkspacePullRequestError>,
      ) => safe(options.resolveCheckoutPath(request).pipe(Effect.flatMap(use)))
      return WorkspacePullRequestRpcGroup.toLayer({
        'pull-requests:list': request => checkout(request, root => service.list(root, request)),
        'pull-requests:detail': request => checkout(request, root => service.detail(root, request.number)),
        'pull-requests:checks': request => checkout(request, root => service.checks(root, request.number)),
        'pull-requests:diff': request => checkout(request, root => service.diff(root, request.number, request.path)),
        'pull-requests:threads': request =>
          checkout(request, root => service.threads(root, request.number, request.cursor)),
        'pull-requests:comment': request => checkout(request, root => service.comment(root, request)),
        'pull-requests:review': request => checkout(request, root => service.review(root, request)),
        'pull-requests:reply': request => checkout(request, root => service.reply(root, request)),
        'pull-requests:resolveThread': request => checkout(request, root => service.resolveThread(root, request)),
        'pull-requests:action': request => checkout(request, root => service.action(root, request)),
        'pull-requests:update': request => checkout(request, root => service.update(root, request)),
        'pull-requests:create': request => checkout(request, root => service.create(root, request)),
      })
    }),
  )
}
