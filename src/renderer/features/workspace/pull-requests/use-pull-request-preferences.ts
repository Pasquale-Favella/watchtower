import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useEffect, useState } from 'react'

import {
  pullRequestReviewCommentSchema,
  pullRequestReviewRequestSchema,
} from '@/shared/schemas/workspace-pull-requests.js'

const VIEWED_KEY = 'watchtower.workspace.pull-request-viewed.v1'
const viewedSchema = Schema.Record(Schema.String, Schema.Array(Schema.String).check(Schema.isMaxLength(2000)))
const REVIEW_KEY = 'watchtower.workspace.pull-request-review.v1'
const reviewDraftSchema = Schema.Struct({
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  verdict: pullRequestReviewRequestSchema.fields.verdict,
  comments: Schema.Array(pullRequestReviewCommentSchema).check(Schema.isMaxLength(100)),
})
type ReviewDraft = Schema.Schema.Type<typeof reviewDraftSchema>
const reviewDraftsSchema = Schema.Record(Schema.String, reviewDraftSchema)
const EMPTY_DRAFT: ReviewDraft = { body: '', verdict: 'comment', comments: [] }

function readReviewDrafts(): Record<string, ReviewDraft> {
  try {
    const raw = localStorage.getItem(REVIEW_KEY)
    if (!raw) return {}
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(reviewDraftsSchema))(raw)
    return Option.isSome(decoded) ? decoded.value : {}
  } catch {
    return {}
  }
}

export function usePullRequestReviewDraft(identity: string) {
  const [state, setState] = useState<{ readonly identity: string; readonly value: ReviewDraft }>(() => ({
    identity,
    value: readReviewDrafts()[identity] ?? EMPTY_DRAFT,
  }))
  const value = state.identity === identity ? state.value : (readReviewDrafts()[identity] ?? EMPTY_DRAFT)
  useEffect(() => {
    if (state.identity !== identity) return
    try {
      localStorage.setItem(
        REVIEW_KEY,
        JSON.stringify(
          Object.fromEntries(Object.entries({ ...readReviewDrafts(), [identity]: state.value }).slice(-100)),
        ),
      )
    } catch {
      /* The current review draft remains editable without persistence. */
    }
  }, [identity, state])
  return {
    value,
    update: (change: (draft: ReviewDraft) => ReviewDraft) =>
      setState(previous => ({ identity, value: change(previous.identity === identity ? previous.value : value) })),
  }
}

function readViewedFiles(): Record<string, readonly string[]> {
  try {
    const value = localStorage.getItem(VIEWED_KEY)
    if (!value) return {}
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(viewedSchema))(value)
    return Option.isSome(decoded) ? decoded.value : {}
  } catch {
    return {}
  }
}

export function usePullRequestViewedFiles(identity: string) {
  const [state, setState] = useState<{ readonly identity: string; readonly paths: readonly string[] }>(() => ({
    identity,
    paths: readViewedFiles()[identity] ?? [],
  }))
  const paths = state.identity === identity ? state.paths : (readViewedFiles()[identity] ?? [])
  return {
    paths,
    setViewed: (path: string, viewed: boolean) => {
      const next = viewed ? [...new Set([...paths, path])] : paths.filter(candidate => candidate !== path)
      setState({ identity, paths: next })
      try {
        const stored = { ...readViewedFiles(), [identity]: next }
        localStorage.setItem(VIEWED_KEY, JSON.stringify(Object.fromEntries(Object.entries(stored).slice(-100))))
      } catch {
        /* Review progress stays available for the current view. */
      }
    },
  }
}
