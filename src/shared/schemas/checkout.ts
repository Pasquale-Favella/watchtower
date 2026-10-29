import * as Schema from 'effect/Schema'

const path = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/))
const ref = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isPattern(/^[^-\0][^\0]*$/))
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const checkoutResolverErrorCodeSchema = Schema.Literals([
  'path-missing',
  'not-a-directory',
  'not-a-repository',
  'git-unavailable',
  'dirty-checkout',
  'worktree-conflict',
  'invalid-input',
  'filesystem-unavailable',
  'git-failed',
])
export type CheckoutResolverErrorCode = Schema.Schema.Type<typeof checkoutResolverErrorCodeSchema>

export class CheckoutResolverError extends Schema.TaggedError<CheckoutResolverError>()('CheckoutResolverError', {
  code: checkoutResolverErrorCodeSchema,
  message: Schema.String,
}) {}

export const checkoutDirtySummarySchema = Schema.Struct({
  trackedChanges: count,
  untrackedCount: count,
  ignoredCount: count,
})

const checkoutFields = { canonicalPath: path, dirty: checkoutDirtySummarySchema }
export const resolvedCheckoutSchema = Schema.Union([
  Schema.Struct({
    ...checkoutFields,
    kind: Schema.Literals(['main', 'worktree']),
    repositoryIdentity: path,
    mainCheckoutPath: path,
    branch: Schema.NullOr(Schema.String),
    headRevision: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...checkoutFields,
    kind: Schema.Literal('directory'),
    repositoryIdentity: Schema.Null,
    mainCheckoutPath: Schema.Null,
    branch: Schema.Null,
    headRevision: Schema.Null,
  }),
])
export type ResolvedCheckout = Schema.Schema.Type<typeof resolvedCheckoutSchema>

export const resolveCheckoutRequestSchema = Schema.Struct({ path })
export type ResolveCheckoutRequest = Schema.Schema.Type<typeof resolveCheckoutRequestSchema>

export const createIsolatedWorktreeRequestSchema = Schema.Struct({
  repositoryPath: path,
  worktreePath: path,
  branch: ref,
  baseRevision: Schema.optional(ref),
})
export type CreateIsolatedWorktreeRequest = Schema.Schema.Type<typeof createIsolatedWorktreeRequestSchema>

export const removeWorktreeRequestSchema = Schema.Struct({
  worktreePath: path,
  force: Schema.Literal(false),
})
export type RemoveWorktreeRequest = Schema.Schema.Type<typeof removeWorktreeRequestSchema>
export const removeWorktreeResponseSchema = Schema.Void
