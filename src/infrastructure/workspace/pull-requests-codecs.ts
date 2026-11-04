import * as Schema from 'effect/Schema'

import type { WorkspacePullRequestSummary } from '@/shared/schemas/workspace-pull-requests.js'

const string = Schema.String
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const actor = Schema.NullOr(Schema.Struct({ login: string }))
export const ghRepositorySchema = Schema.Struct({
  nameWithOwner: string.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  url: string.check(Schema.isPattern(/^https?:\/\//)),
  defaultBranchRef: Schema.NullOr(Schema.Struct({ name: string })),
})
export const ghSummarySchema = Schema.Struct({
  number: count,
  title: string,
  url: string,
  state: Schema.Literals(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: Schema.Boolean,
  author: actor,
  headRefName: string,
  baseRefName: string,
  updatedAt: string,
  additions: count,
  deletions: count,
  reviewDecision: Schema.NullOr(string),
})
export type GhSummary = Schema.Schema.Type<typeof ghSummarySchema>
export const GH_SUMMARY_FIELDS =
  'number,title,url,state,isDraft,author,headRefName,baseRefName,updatedAt,additions,deletions,reviewDecision'
export const ghCommentSchema = Schema.Struct({
  id: string,
  author: actor,
  body: string,
  url: string,
  createdAt: string,
})
export const ghReviewSchema = Schema.Struct({
  id: string,
  author: actor,
  body: string,
  state: string,
  submittedAt: Schema.NullOr(string),
})
export const ghDetailSchema = Schema.Struct({
  ...ghSummarySchema.fields,
  body: string,
  headRefOid: string,
  mergeable: string,
  mergeStateStatus: string,
  changedFiles: count,
  files: Schema.Array(Schema.Struct({ path: string, additions: count, deletions: count })),
  labels: Schema.Array(Schema.Struct({ name: string })),
  assignees: Schema.Array(Schema.Struct({ login: string })),
  reviewRequests: Schema.Array(Schema.Struct({ login: Schema.optional(string), name: Schema.optional(string) })),
  comments: Schema.Array(ghCommentSchema),
  reviews: Schema.Array(ghReviewSchema),
})
export const GH_DETAIL_FIELDS = `${GH_SUMMARY_FIELDS},body,headRefOid,mergeable,mergeStateStatus,changedFiles,files,labels,assignees,reviewRequests,comments,reviews`
export const ghChecksSchema = Schema.Array(
  Schema.Struct({
    name: string,
    state: string,
    bucket: string,
    link: Schema.NullOr(string),
    workflow: Schema.NullOr(string),
  }),
)
export const ghFilePatchesSchema = Schema.Array(
  Schema.Struct({
    filename: string,
    patch: Schema.optional(string),
    status: string,
    additions: count,
    deletions: count,
  }),
)
export const ghThreadsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  id: string,
                  path: string,
                  line: Schema.NullOr(count),
                  isResolved: Schema.Boolean,
                  comments: Schema.Struct({
                    nodes: Schema.Array(ghCommentSchema),
                    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
                  }),
                }),
              ),
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(string) }),
            }),
          }),
        ),
      }),
    ),
  }),
})
export const ghThreadOwnerSchema = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.Struct({ number: count, repository: Schema.Struct({ nameWithOwner: string }) }),
      }),
    ),
  }),
})
export const ghMutationSchema = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })

export function normalizeSummary(raw: GhSummary): WorkspacePullRequestSummary {
  const states = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: states[raw.state],
    isDraft: raw.isDraft,
    author: raw.author?.login ?? null,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    updatedAt: raw.updatedAt,
    additions: raw.additions,
    deletions: raw.deletions,
    reviewDecision: raw.reviewDecision ?? '',
  }
}

export const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id path line isResolved comments(first:100){nodes{id author{login} body url createdAt} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}`
export const THREAD_OWNER_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{number repository{nameWithOwner}}}}}`
