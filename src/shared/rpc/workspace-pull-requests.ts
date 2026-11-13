import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import * as Requests from '@/shared/schemas/workspace-pull-requests.js'

export const pullRequestRpcMessages = {
  unavailable: 'GitHub CLI could not access this repository. Check its GitHub remote and authentication.',
  'not-found': 'The pull request or checkout was not found.',
  'invalid-request': 'Pull request request is invalid.',
  'output-limit': 'The pull request response exceeded its display limit.',
  timeout: 'GitHub did not respond in time. Try again.',
  conflict: 'The pull request changed. Refresh it before retrying.',
  failed: 'The pull request operation failed.',
} as const

export class WorkspacePullRequestRpcError extends Schema.TaggedError<WorkspacePullRequestRpcError>()(
  'WorkspacePullRequestRpcError',
  {
    code: Schema.Literals(
      Object.keys(pullRequestRpcMessages) as [
        keyof typeof pullRequestRpcMessages,
        ...Array<keyof typeof pullRequestRpcMessages>,
      ],
    ),
    message: Schema.Literals(Object.values(pullRequestRpcMessages)),
  },
) {}

const error = WorkspacePullRequestRpcError
export const WorkspacePullRequestRpcGroup = RpcGroup.make(
  Rpc.make('pull-requests:list', {
    payload: Requests.pullRequestListRequestSchema,
    success: Requests.pullRequestListSchema,
    error,
  }),
  Rpc.make('pull-requests:detail', {
    payload: Requests.pullRequestRefSchema,
    success: Requests.pullRequestDetailSchema,
    error,
  }),
  Rpc.make('pull-requests:checks', {
    payload: Requests.pullRequestRefSchema,
    success: Requests.pullRequestChecksSchema,
    error,
  }),
  Rpc.make('pull-requests:diff', {
    payload: Requests.pullRequestDiffRequestSchema,
    success: Requests.pullRequestDiffSchema,
    error,
  }),
  Rpc.make('pull-requests:threads', {
    payload: Requests.pullRequestThreadsRequestSchema,
    success: Requests.pullRequestThreadsSchema,
    error,
  }),
  Rpc.make('pull-requests:comment', { payload: Requests.pullRequestCommentRequestSchema, success: Schema.Void, error }),
  Rpc.make('pull-requests:review', { payload: Requests.pullRequestReviewRequestSchema, success: Schema.Void, error }),
  Rpc.make('pull-requests:reply', {
    payload: Requests.pullRequestThreadReplyRequestSchema,
    success: Schema.Void,
    error,
  }),
  Rpc.make('pull-requests:resolveThread', {
    payload: Requests.pullRequestThreadResolutionRequestSchema,
    success: Schema.Void,
    error,
  }),
  Rpc.make('pull-requests:action', { payload: Requests.pullRequestActionRequestSchema, success: Schema.Void, error }),
  Rpc.make('pull-requests:update', { payload: Requests.pullRequestUpdateRequestSchema, success: Schema.Void, error }),
  Rpc.make('pull-requests:create', {
    payload: Requests.pullRequestCreateRequestSchema,
    success: Requests.pullRequestSummarySchema,
    error,
  }),
)
