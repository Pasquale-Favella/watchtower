import * as Schema from 'effect/Schema'

import { checkoutFilePathSchema, checkoutScopeSchema } from './checkout-inspection.js'

export const checkoutActionMessages = {
  unavailable: 'The checkout is unavailable.',
  'invalid-path': 'The file path must stay inside the checkout.',
  'not-repository': 'This checkout is not a Git repository.',
  'nothing-staged': 'Stage changes before committing.',
  'git-failed': 'Git could not complete the operation. Check the repository status and Git configuration.',
} as const

export class CheckoutActionError extends Schema.TaggedError<CheckoutActionError>()('CheckoutActionError', {
  code: Schema.Literals(['unavailable', 'invalid-path', 'not-repository', 'nothing-staged', 'git-failed']),
  message: Schema.String,
}) {}

export const checkoutPathsActionSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  paths: Schema.Array(checkoutFilePathSchema).check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
})
export const checkoutCommitActionSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384), Schema.isPattern(/\S/)),
})
export const checkoutGitFileSchema = Schema.Struct({
  path: checkoutFilePathSchema,
  previousPath: Schema.optional(checkoutFilePathSchema),
  index: Schema.String,
  workingTree: Schema.String,
})
export const checkoutGitStatusSchema = Schema.Struct({
  files: Schema.Array(checkoutGitFileSchema),
  truncated: Schema.Boolean,
})
export const checkoutCommitReceiptSchema = Schema.Struct({ revision: Schema.String })
export type CheckoutGitStatus = Schema.Schema.Type<typeof checkoutGitStatusSchema>
export type CheckoutGitFile = Schema.Schema.Type<typeof checkoutGitFileSchema>
