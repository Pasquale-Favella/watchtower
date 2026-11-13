import * as Schema from 'effect/Schema'

import type { MethodContracts } from './office/worker-rpc.js'

export type ExtendedPreviewKind =
  'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'rtf' | 'epub' | 'ipynb' | 'pdf' | 'font' | 'archive' | 'sqlite'

const DOCUMENTS: readonly ExtendedPreviewKind[] = [
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  'ipynb',
  'pdf',
]

export function extendedFilePreviewKind(path: string): ExtendedPreviewKind | null {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  const document = DOCUMENTS.find(kind => kind === extension)
  if (document) return document
  if (['woff', 'woff2', 'ttf', 'otf'].includes(extension)) return 'font'
  if (['zip', 'tar', 'gz', 'tgz'].includes(extension)) return 'archive'
  if (['sqlite', 'sqlite3', 'db', 'db3'].includes(extension)) return 'sqlite'
  return null
}

const strings = Schema.Array(Schema.String)
const previewEntrySchema = Schema.Struct({ name: Schema.String, size: Schema.Number, directory: Schema.Boolean })
const notebookCellSchema = Schema.Struct({
  kind: Schema.Literals(['markdown', 'code', 'raw']),
  source: Schema.String,
  outputs: Schema.Array(Schema.Struct({ kind: Schema.Literals(['text', 'html', 'image']), value: Schema.String })),
})
export type PreviewEntry = Schema.Schema.Type<typeof previewEntrySchema>
export type NotebookCell = Schema.Schema.Type<typeof notebookCellSchema>
export const previewDocumentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('document'),
    pages: strings,
    names: Schema.optional(strings),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal('table'),
    names: strings,
    selected: Schema.String,
    columns: strings,
    rows: Schema.Array(strings),
    offset: Schema.Number,
    totalRows: Schema.Number,
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal('archive'),
    entries: Schema.Array(previewEntrySchema),
    selected: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    image: Schema.optional(Schema.String),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal('notebook'),
    cells: Schema.Array(notebookCellSchema),
    truncated: Schema.Boolean,
  }),
])
export type PreviewDocument = Schema.Schema.Type<typeof previewDocumentSchema>
export const openPreviewSchema = Schema.Struct({ path: Schema.String, bytes: Schema.instanceOf(ArrayBuffer) })
export const selectPreviewSchema = Schema.Struct({
  name: Schema.String,
  page: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})
export const closePreviewSchema = Schema.Undefined

export type PreviewMethods = {
  readonly open: {
    readonly input: { readonly path: string; readonly bytes: ArrayBuffer }
    readonly output: PreviewDocument
  }
  readonly select: {
    readonly input: { readonly name: string; readonly page?: number }
    readonly output: PreviewDocument
  }
  readonly close: { readonly input: undefined; readonly output: undefined }
}
export const previewWorkerContracts = {
  open: { input: openPreviewSchema, output: previewDocumentSchema },
  select: { input: selectPreviewSchema, output: previewDocumentSchema },
  close: { input: closePreviewSchema, output: Schema.Undefined },
} satisfies MethodContracts<PreviewMethods>

export const PREVIEW_LIMIT = 50 * 1024 * 1024
export const PAGE_ROWS = 200
