import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  CheckoutBranchList,
  DiffSource,
  DiffSourceSelector,
  DirectoryListing,
  FileContent,
  FilePatch,
} from '@/shared/schemas/checkout-inspection.js'

export class CheckoutInspectionError extends Schema.TaggedError<CheckoutInspectionError>()('CheckoutInspectionError', {
  code: Schema.Literals([
    'unavailable',
    'not-repository',
    'invalid-request',
    'outside-checkout',
    'path-not-found',
    'base-unavailable',
    'failed',
  ]),
  /** Diagnostic text for the operational log only. RPC handlers replace it with fixed messages. */
  message: Schema.String,
}) {}

export interface CheckoutFilePatchRequest {
  readonly source: DiffSourceSelector
  readonly path: string
  readonly previousPath?: string | undefined
}

/** Read-only review of one checkout. `root` is the canonical checkout path chosen by the caller. */
export class CheckoutInspection extends Context.Service<
  CheckoutInspection,
  {
    readonly diffPreview: (
      root: string,
      source: DiffSourceSelector,
    ) => Effect.Effect<DiffSource, CheckoutInspectionError>
    readonly filePatch: (
      root: string,
      request: CheckoutFilePatchRequest,
    ) => Effect.Effect<FilePatch, CheckoutInspectionError>
    readonly branches: (root: string) => Effect.Effect<CheckoutBranchList, CheckoutInspectionError>
    readonly listEntries: (root: string, path: string) => Effect.Effect<DirectoryListing, CheckoutInspectionError>
    readonly readFile: (root: string, path: string) => Effect.Effect<FileContent, CheckoutInspectionError>
  }
>()('watchtower/core/CheckoutInspection') {}
