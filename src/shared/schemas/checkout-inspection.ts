import * as Schema from 'effect/Schema'

import { projectIdSchema, workspaceCheckoutIdSchema } from './workspace.js'

/** Bounds shared by the inspector and the renderer. Lists stop at these counts and report `truncated`. */
export const CHECKOUT_DIFF_FILE_LIMIT = 2000
export const CHECKOUT_UNTRACKED_SCAN_LIMIT = 5000
export const CHECKOUT_BRANCH_LIMIT = 200
export const CHECKOUT_COMMIT_LIMIT = 200
export const CHECKOUT_DIRECTORY_ENTRY_LIMIT = 2000
export const CHECKOUT_PATCH_MAX_BYTES = 1024 * 1024
export const CHECKOUT_FILE_MAX_BYTES = 1024 * 1024
export const CHECKOUT_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** A path relative to the checkout root. Absolute forms, parent segments, `.` and `.git` are rejected. */
export function isContainedCheckoutPath(value: string): boolean {
  if (value.includes('\0') || /^(?:[A-Za-z]:|[\\/])/.test(value)) return false
  return value
    .split(/[\\/]/)
    .every(segment => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git')
}

const containedFilter = Schema.makeFilter<string>(
  value => isContainedCheckoutPath(value) || 'Path must stay inside the checkout.',
)
export const checkoutFilePathSchema = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isMinLength(1),
  containedFilter,
)
export const checkoutDirectoryPathSchema = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter<string>(
    value => value === '' || isContainedCheckoutPath(value) || 'Path must stay inside the checkout.',
  ),
)

/** Git-reported paths are data from the repository, so they only need a bounded, NUL-free shape. */
export const gitPathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[^\0]+$/),
)

/** Refs are user-chosen names. A leading dash would read as a Git option, so it is refused before Git runs. */
export const gitRefSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^\s\0-][^\s\0]*$/),
)

export const checkoutScopeSchema = Schema.Struct({
  projectId: projectIdSchema,
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
})
export type CheckoutScope = Schema.Schema.Type<typeof checkoutScopeSchema>

/** Uncommitted changes against HEAD, or the working tree against the merge-base with a base ref. */
export const diffSourceSelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('working-tree'), ignoreWhitespace: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal('staged'), ignoreWhitespace: Schema.optional(Schema.Boolean) }),
  Schema.Struct({
    kind: Schema.Literal('commit'),
    commit: gitRefSchema,
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal('branch-range'),
    baseRef: Schema.optional(gitRefSchema),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
])
export type DiffSourceSelector = Schema.Schema.Type<typeof diffSourceSelectorSchema>

export const diffPreviewRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  source: diffSourceSelectorSchema,
})
export type DiffPreviewRequest = Schema.Schema.Type<typeof diffPreviewRequestSchema>

export const diffFileStatusSchema = Schema.Literals(['added', 'modified', 'deleted', 'renamed'])
export const diffFileSchema = Schema.Struct({
  path: gitPathSchema,
  previousPath: Schema.optional(gitPathSchema),
  status: diffFileStatusSchema,
  additions: count,
  deletions: count,
  binary: Schema.Boolean,
})
export type DiffFile = Schema.Schema.Type<typeof diffFileSchema>

export const diffSourceSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(512)),
  kind: Schema.Literals(['working-tree', 'branch-range', 'staged', 'commit']),
  title: Schema.String.check(Schema.isMaxLength(512)),
  baseRef: Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
  headRef: Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
  files: Schema.Array(diffFileSchema).check(Schema.isMaxLength(CHECKOUT_DIFF_FILE_LIMIT)),
  truncated: Schema.Boolean,
})
export type DiffSource = Schema.Schema.Type<typeof diffSourceSchema>

export const filePatchRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  source: diffSourceSelectorSchema,
  path: checkoutFilePathSchema,
  previousPath: Schema.optional(checkoutFilePathSchema),
  includeContents: Schema.optional(Schema.Boolean),
  contextLines: Schema.optional(count.check(Schema.isLessThanOrEqualTo(100000))),
})
export const filePatchSchema = Schema.Struct({
  binary: Schema.Boolean,
  patch: Schema.String.check(Schema.isMaxLength(CHECKOUT_PATCH_MAX_BYTES * 4)),
  truncated: Schema.Boolean,
  oldContent: Schema.optional(Schema.String.check(Schema.isMaxLength(CHECKOUT_FILE_MAX_BYTES * 4))),
  newContent: Schema.optional(Schema.String.check(Schema.isMaxLength(CHECKOUT_FILE_MAX_BYTES * 4))),
})
export type FilePatch = Schema.Schema.Type<typeof filePatchSchema>
export type FilePatchRequest = Schema.Schema.Type<typeof filePatchRequestSchema>

export const checkoutBranchSchema = Schema.Struct({
  name: gitRefSchema,
  kind: Schema.Literals(['local', 'remote']),
  current: Schema.Boolean,
})
export const checkoutBranchListSchema = Schema.Struct({
  items: Schema.Array(checkoutBranchSchema).check(Schema.isMaxLength(CHECKOUT_BRANCH_LIMIT)),
  truncated: Schema.Boolean,
})
export type CheckoutBranchList = Schema.Schema.Type<typeof checkoutBranchListSchema>

export const checkoutCommitListSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
      subject: Schema.String,
      authoredAt: Schema.String,
    }),
  ).check(Schema.isMaxLength(CHECKOUT_COMMIT_LIMIT)),
  truncated: Schema.Boolean,
})
export type CheckoutCommitList = Schema.Schema.Type<typeof checkoutCommitListSchema>

export const listEntriesRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  includeIgnored: Schema.optional(Schema.Boolean),
  path: checkoutDirectoryPathSchema,
})
export type ListEntriesRequest = Schema.Schema.Type<typeof listEntriesRequestSchema>
export const directoryEntrySchema = Schema.Struct({
  ignored: Schema.optional(Schema.Boolean),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  path: gitPathSchema,
  kind: Schema.Literals(['file', 'directory']),
  size: Schema.NullOr(count),
})
export const directoryListingSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  entries: Schema.Array(directoryEntrySchema).check(Schema.isMaxLength(CHECKOUT_DIRECTORY_ENTRY_LIMIT)),
  truncated: Schema.Boolean,
})
export type DirectoryListing = Schema.Schema.Type<typeof directoryListingSchema>
export type DirectoryEntry = Schema.Schema.Type<typeof directoryEntrySchema>

export const readFileRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  includeIgnored: Schema.optional(Schema.Boolean),
  path: checkoutFilePathSchema,
})
export const fileContentSchema = Schema.Struct({
  path: gitPathSchema,
  /** Identifies the on-disk bytes read, including a revert to previously seen content. */
  revision: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  size: count,
  binary: Schema.Boolean,
  /** UTF-8 text, or null when the file is binary or not valid UTF-8. */
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(CHECKOUT_FILE_MAX_BYTES * 4))),
  previewDataUrl: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(Math.ceil(CHECKOUT_PREVIEW_MAX_BYTES / 3) * 4 + 128),
      Schema.isPattern(
        /^data:(?:image\/(?:png|jpeg|gif|webp|bmp|tiff)|audio\/(?:mpeg|wav|ogg|flac)|video\/(?:mp4|webm|ogg)|application\/(?:pdf|octet-stream)|font\/(?:woff|woff2|ttf|otf));base64,[A-Za-z0-9+/]+={0,2}$/,
      ),
    ),
  ),
  truncated: Schema.Boolean,
})
export type FileContent = Schema.Schema.Type<typeof fileContentSchema>
export type ReadFileRequest = Schema.Schema.Type<typeof readFileRequestSchema>

export const writeFileRequestSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  includeIgnored: Schema.optional(Schema.Boolean),
  path: checkoutFilePathSchema,
  content: Schema.String.check(Schema.isMaxLength(CHECKOUT_FILE_MAX_BYTES)),
  expectedContent: Schema.String.check(Schema.isMaxLength(CHECKOUT_FILE_MAX_BYTES)),
})
export type WriteFileRequest = Schema.Schema.Type<typeof writeFileRequestSchema>
