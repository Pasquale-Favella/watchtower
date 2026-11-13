import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type * as Requests from '@/shared/schemas/workspace-pull-requests.js'

export class WorkspacePullRequestError extends Schema.TaggedError<WorkspacePullRequestError>()(
  'WorkspacePullRequestError',
  {
    code: Schema.Literals([
      'unavailable',
      'not-found',
      'invalid-request',
      'output-limit',
      'timeout',
      'conflict',
      'failed',
    ]),
    message: Schema.String,
  },
) {}

/** The platform resolves root from registered checkout identity before invoking these operations. */
export class WorkspacePullRequests extends Context.Service<
  WorkspacePullRequests,
  {
    readonly list: (
      root: string,
      request: Requests.WorkspacePullRequestListRequest,
    ) => Effect.Effect<Requests.WorkspacePullRequestList, WorkspacePullRequestError>
    readonly detail: (
      root: string,
      number: number,
    ) => Effect.Effect<Requests.WorkspacePullRequestDetail, WorkspacePullRequestError>
    readonly checks: (
      root: string,
      number: number,
    ) => Effect.Effect<Requests.WorkspacePullRequestChecks, WorkspacePullRequestError>
    readonly diff: (
      root: string,
      number: number,
      path?: string,
    ) => Effect.Effect<Requests.WorkspacePullRequestDiff, WorkspacePullRequestError>
    readonly threads: (
      root: string,
      number: number,
      cursor?: string,
    ) => Effect.Effect<Requests.WorkspacePullRequestThreads, WorkspacePullRequestError>
    readonly comment: (
      root: string,
      request: Requests.WorkspacePullRequestCommentRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly review: (
      root: string,
      request: Requests.WorkspacePullRequestReviewRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly reply: (
      root: string,
      request: Requests.WorkspacePullRequestThreadReplyRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly resolveThread: (
      root: string,
      request: Requests.WorkspacePullRequestThreadResolutionRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly action: (
      root: string,
      request: Requests.WorkspacePullRequestActionRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly update: (
      root: string,
      request: Requests.WorkspacePullRequestUpdateRequest,
    ) => Effect.Effect<void, WorkspacePullRequestError>
    readonly create: (
      root: string,
      request: Requests.WorkspacePullRequestCreateRequest,
    ) => Effect.Effect<Requests.WorkspacePullRequestSummary, WorkspacePullRequestError>
  }
>()('watchtower/core/WorkspacePullRequests') {}
