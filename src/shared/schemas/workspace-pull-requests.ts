import * as Schema from 'effect/Schema'

import { checkoutFilePathSchema, checkoutScopeSchema, gitRefSchema } from './checkout-inspection.js'

export const PULL_REQUEST_LIST_LIMIT = 100
export const PULL_REQUEST_DIFF_MAX_BYTES = 2 * 1024 * 1024
const short = Schema.String.check(Schema.isMaxLength(4096))
const text = Schema.String.check(Schema.isMaxLength(65_536))
const requiredText = text.check(Schema.isMinLength(1))
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512), Schema.isPattern(/^[^\s\0]+$/))
export const pullRequestNumberSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const url = Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^https?:\/\//))
const revision = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{40,64}$/))
export const pullRequestRepositorySchema = Schema.Struct({
  host: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?$/),
  ),
  nameWithOwner: Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
})
export type WorkspacePullRequestRepository = Schema.Schema.Type<typeof pullRequestRepositorySchema>
export const pullRequestRefSchema = Schema.Struct({ ...checkoutScopeSchema.fields, number: pullRequestNumberSchema })
export const pullRequestStateSchema = Schema.Literals(['open', 'closed', 'merged'])

export const pullRequestSummarySchema = Schema.Struct({
  number: pullRequestNumberSchema,
  title: short,
  url,
  state: pullRequestStateSchema,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(short),
  headRefName: short,
  baseRefName: short,
  updatedAt: short,
  additions: count,
  deletions: count,
  reviewDecision: short,
})
export type WorkspacePullRequestSummary = Schema.Schema.Type<typeof pullRequestSummarySchema>
export const pullRequestListRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  state: Schema.optional(Schema.Literals(['open', 'closed', 'merged', 'all'])),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  currentBranchOnly: Schema.optional(Schema.Boolean),
})
export type WorkspacePullRequestListRequest = Schema.Schema.Type<typeof pullRequestListRequestSchema>
export const pullRequestListSchema = Schema.Struct({
  repository: short,
  repositoryIdentity: pullRequestRepositorySchema,
  repositoryUrl: url,
  defaultBranch: Schema.NullOr(short),
  currentBranch: Schema.NullOr(short),
  items: Schema.Array(pullRequestSummarySchema),
  truncated: Schema.Boolean,
})
export type WorkspacePullRequestList = Schema.Schema.Type<typeof pullRequestListSchema>
export const pullRequestFileSchema = Schema.Struct({ path: short, additions: count, deletions: count })
export const pullRequestCommentSchema = Schema.Struct({
  id,
  author: Schema.NullOr(short),
  body: text,
  url,
  createdAt: short,
})
export const pullRequestReviewSchema = Schema.Struct({
  id,
  author: Schema.NullOr(short),
  body: text,
  state: short,
  submittedAt: Schema.NullOr(short),
})
export const pullRequestDetailSchema = Schema.Struct({
  ...pullRequestSummarySchema.fields,
  repository: short,
  repositoryIdentity: pullRequestRepositorySchema,
  body: text,
  headRevision: revision,
  mergeable: short,
  mergeStateStatus: short,
  changedFiles: count,
  files: Schema.Array(pullRequestFileSchema),
  filesTruncated: Schema.Boolean,
  labels: Schema.Array(short),
  assignees: Schema.Array(short),
  reviewers: Schema.Array(short),
  comments: Schema.Array(pullRequestCommentSchema),
  reviews: Schema.Array(pullRequestReviewSchema),
})
export type WorkspacePullRequestDetail = Schema.Schema.Type<typeof pullRequestDetailSchema>
export const pullRequestCheckSchema = Schema.Struct({
  name: short,
  state: short,
  bucket: short,
  link: Schema.NullOr(url),
  workflow: short,
})
export const pullRequestChecksSchema = Schema.Struct({
  items: Schema.Array(pullRequestCheckSchema),
  truncated: Schema.Boolean,
})
export type WorkspacePullRequestChecks = Schema.Schema.Type<typeof pullRequestChecksSchema>
export const pullRequestDiffRequestSchema = Schema.Struct({
  ...pullRequestRefSchema.fields,
  path: Schema.optional(checkoutFilePathSchema),
})
export const pullRequestDiffSchema = Schema.Struct({
  available: Schema.Boolean,
  patch: Schema.String.check(Schema.isMaxLength(PULL_REQUEST_DIFF_MAX_BYTES * 2)),
  truncated: Schema.Boolean,
})
export type WorkspacePullRequestDiff = Schema.Schema.Type<typeof pullRequestDiffSchema>
export const pullRequestThreadSchema = Schema.Struct({
  id,
  path: short,
  line: Schema.NullOr(count),
  resolved: Schema.Boolean,
  comments: Schema.Array(pullRequestCommentSchema),
  commentsTruncated: Schema.Boolean,
})
export const pullRequestThreadsRequestSchema = Schema.Struct({
  ...pullRequestRefSchema.fields,
  cursor: Schema.optional(id),
})
export const pullRequestThreadsSchema = Schema.Struct({
  items: Schema.Array(pullRequestThreadSchema),
  nextCursor: Schema.NullOr(id),
})
export type WorkspacePullRequestThreads = Schema.Schema.Type<typeof pullRequestThreadsSchema>
const mutationRefSchema = Schema.Struct({
  ...pullRequestRefSchema.fields,
  expectedRepository: pullRequestRepositorySchema,
})
export const pullRequestCommentRequestSchema = Schema.Struct({ ...mutationRefSchema.fields, body: requiredText })
export type WorkspacePullRequestCommentRequest = Schema.Schema.Type<typeof pullRequestCommentRequestSchema>
export const pullRequestReviewCommentSchema = Schema.Struct({
  path: checkoutFilePathSchema,
  line: pullRequestNumberSchema,
  side: Schema.Literals(['LEFT', 'RIGHT']),
  body: requiredText,
})
export const pullRequestReviewRequestSchema = Schema.Struct({
  ...mutationRefSchema.fields,
  verdict: Schema.Literals(['comment', 'approve', 'request-changes']),
  body: text,
  headRevision: revision,
  comments: Schema.optional(Schema.Array(pullRequestReviewCommentSchema).check(Schema.isMaxLength(100))),
})
export type WorkspacePullRequestReviewRequest = Schema.Schema.Type<typeof pullRequestReviewRequestSchema>
export const pullRequestThreadReplyRequestSchema = Schema.Struct({
  ...mutationRefSchema.fields,
  threadId: id,
  body: requiredText,
})
export const pullRequestThreadResolutionRequestSchema = Schema.Struct({
  ...mutationRefSchema.fields,
  threadId: id,
  resolved: Schema.Boolean,
})
export type WorkspacePullRequestThreadReplyRequest = Schema.Schema.Type<typeof pullRequestThreadReplyRequestSchema>
export type WorkspacePullRequestThreadResolutionRequest = Schema.Schema.Type<
  typeof pullRequestThreadResolutionRequestSchema
>
export const pullRequestActionRequestSchema = Schema.Struct({
  ...mutationRefSchema.fields,
  action: Schema.Literals(['close', 'reopen', 'ready', 'draft', 'merge', 'update-branch']),
  mergeMethod: Schema.optional(Schema.Literals(['merge', 'squash', 'rebase'])),
  headRevision: Schema.optional(revision),
})
export type WorkspacePullRequestActionRequest = Schema.Schema.Type<typeof pullRequestActionRequestSchema>
export const pullRequestUpdateRequestSchema = Schema.Struct({
  ...mutationRefSchema.fields,
  title: Schema.optional(short),
  body: Schema.optional(text),
  addLabels: Schema.optional(Schema.Array(short).check(Schema.isMaxLength(100))),
  removeLabels: Schema.optional(Schema.Array(short).check(Schema.isMaxLength(100))),
  addReviewers: Schema.optional(Schema.Array(short).check(Schema.isMaxLength(100))),
  removeReviewers: Schema.optional(Schema.Array(short).check(Schema.isMaxLength(100))),
})
export type WorkspacePullRequestUpdateRequest = Schema.Schema.Type<typeof pullRequestUpdateRequestSchema>
export const pullRequestCreateRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  expectedRepository: pullRequestRepositorySchema,
  title: short.check(Schema.isMinLength(1)),
  body: text,
  base: gitRefSchema,
  head: Schema.optional(gitRefSchema),
  draft: Schema.Boolean,
})
export type WorkspacePullRequestCreateRequest = Schema.Schema.Type<typeof pullRequestCreateRequestSchema>
