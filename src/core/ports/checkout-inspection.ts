import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  CheckoutBranchList,
  CheckoutCommitList,
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
    'conflict',
    'failed',
  ]),
  /** Diagnostic text for the operational log only. RPC handlers replace it with fixed messages. */
  message: Schema.String,
}) {}

export interface CheckoutFilePatchRequest {
  readonly source: DiffSourceSelector
  readonly path: string
  readonly previousPath?: string | undefined
  readonly includeContents?: boolean | undefined
  readonly contextLines?: number | undefined
}

export interface CheckoutReadOptions {
  readonly includeIgnored?: boolean | undefined
}

export interface CheckoutWriteFileRequest extends CheckoutReadOptions {
  readonly path: string
  readonly content: string
  readonly expectedContent: string
}

/** Review and text editing of one checkout. `root` is the canonical checkout path chosen by the caller. */
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
    readonly commits: (root: string) => Effect.Effect<CheckoutCommitList, CheckoutInspectionError>
    readonly listEntries: (
      root: string,
      path: string,
      options?: CheckoutReadOptions,
    ) => Effect.Effect<DirectoryListing, CheckoutInspectionError>
    readonly readFile: (
      root: string,
      path: string,
      options?: CheckoutReadOptions,
    ) => Effect.Effect<FileContent, CheckoutInspectionError>
    readonly writeFile: (
      root: string,
      request: CheckoutWriteFileRequest,
    ) => Effect.Effect<FileContent, CheckoutInspectionError>
  }
>()('watchtower/core/CheckoutInspection') {}
