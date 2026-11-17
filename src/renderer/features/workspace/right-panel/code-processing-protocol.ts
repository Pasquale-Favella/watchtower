import type { FileDiffMetadata } from '@pierre/diffs'
import * as Schema from 'effect/Schema'

import { type DiffFile, diffFileSchema, type FilePatch, filePatchSchema } from '@/shared/schemas/checkout-inspection.js'

import type { MethodContracts } from './file-previews/office/worker-rpc.js'

export interface CodeSearchFile {
  readonly id: string
  readonly name: string
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly diff?: Pick<FileDiffMetadata, 'isPartial' | 'hunks'> | undefined
}

export interface CodeSearchOptions {
  readonly query: string
  readonly matchCase: boolean
  readonly wholeWord: boolean
  readonly regexp: boolean
}

export interface CodeSearchMatch {
  readonly id: string
  readonly name: string
  readonly line: number
  readonly side: 'additions' | 'deletions'
  readonly column: number
  readonly length: number
}

export type CodeProcessingInput =
  | { readonly kind: 'metadata'; readonly file: DiffFile; readonly patch: FilePatch; readonly cacheKey: string }
  | { readonly kind: 'search'; readonly files: readonly CodeSearchFile[]; readonly options: CodeSearchOptions }

export type CodeProcessingResult =
  | { readonly kind: 'metadata'; readonly metadata: FileDiffMetadata }
  | { readonly kind: 'search'; readonly matches: readonly CodeSearchMatch[]; readonly truncated: boolean }
export type CodeMethods = {
  readonly process: { readonly input: CodeProcessingInput; readonly output: CodeProcessingResult }
}

const index = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const lineIndex = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1))
const contextContentSchema = Schema.Struct({
  type: Schema.Literal('context'),
  lines: index,
  additionLineIndex: index,
  deletionLineIndex: index,
})
const changeContentSchema = Schema.Struct({
  type: Schema.Literal('change'),
  deletions: index,
  deletionLineIndex: lineIndex,
  additions: index,
  additionLineIndex: lineIndex,
})
const hunkShape = Schema.Struct({
  collapsedBefore: index,
  additionStart: index,
  additionCount: index,
  additionLines: index,
  additionLineIndex: lineIndex,
  deletionStart: index,
  deletionCount: index,
  deletionLines: index,
  deletionLineIndex: lineIndex,
  hunkContent: Schema.Array(Schema.Union([contextContentSchema, changeContentSchema])),
  hunkContext: Schema.optional(Schema.String),
  hunkSpecs: Schema.optional(Schema.String),
  splitLineStart: index,
  splitLineCount: index,
  unifiedLineStart: index,
  unifiedLineCount: index,
  noEOFCRDeletions: Schema.Boolean,
  noEOFCRAdditions: Schema.Boolean,
})
type PierreHunk = FileDiffMetadata['hunks'][number]
const hunkSchema = Schema.declare<PierreHunk>((value): value is PierreHunk => Schema.is(hunkShape)(value))
const metadataCoreShape = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(['change', 'rename-pure', 'rename-changed', 'new', 'deleted']),
  hunks: Schema.Array(hunkSchema),
  splitLineCount: index,
  unifiedLineCount: index,
  isPartial: Schema.Boolean,
  deletionLines: Schema.Array(Schema.String),
  additionLines: Schema.Array(Schema.String),
  deletionCharacterCount: index,
  additionCharacterCount: index,
})
const fileDiffMetadataSchema = Schema.declare<FileDiffMetadata>((value): value is FileDiffMetadata =>
  Schema.is(metadataCoreShape)(value),
)
const searchDiffSchema = Schema.declare<NonNullable<CodeSearchFile['diff']>>(
  (value): value is NonNullable<CodeSearchFile['diff']> =>
    Schema.is(Schema.Struct({ isPartial: Schema.Boolean, hunks: Schema.Array(hunkSchema) }))(value),
)
const searchFileSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  before: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
  diff: Schema.optional(searchDiffSchema),
})
const searchOptionsSchema = Schema.Struct({
  query: Schema.String,
  matchCase: Schema.Boolean,
  wholeWord: Schema.Boolean,
  regexp: Schema.Boolean,
})
const codeProcessingInputSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('metadata'),
    file: diffFileSchema,
    patch: filePatchSchema,
    cacheKey: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('search'),
    files: Schema.Array(searchFileSchema),
    options: searchOptionsSchema,
  }),
])
const codeProcessingResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('metadata'), metadata: fileDiffMetadataSchema }),
  Schema.Struct({
    kind: Schema.Literal('search'),
    matches: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        line: index,
        side: Schema.Literals(['additions', 'deletions']),
        column: index,
        length: index,
      }),
    ),
    truncated: Schema.Boolean,
  }),
])

export const codeProcessingWorkerContracts = {
  process: { input: codeProcessingInputSchema, output: codeProcessingResultSchema },
} satisfies MethodContracts<CodeMethods>
