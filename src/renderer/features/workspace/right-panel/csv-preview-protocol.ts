import * as Schema from 'effect/Schema'

import type { Method, MethodContracts } from './file-previews/office/worker-rpc.js'

const index = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const csvParseSchema = Schema.Struct({ content: Schema.String, delimiter: Schema.Literals([',', '\t']) })
export const csvPageRequestSchema = Schema.Struct({ offset: index })
export const csvPageSchema = Schema.Struct({
  headers: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String)),
  offset: index,
  total: index,
  columns: index,
})
export type CsvPage = Schema.Schema.Type<typeof csvPageSchema>
export type CsvMethods = {
  readonly parse: Method<Schema.Schema.Type<typeof csvParseSchema>, CsvPage>
  readonly page: Method<Schema.Schema.Type<typeof csvPageRequestSchema>, CsvPage>
}
export const csvWorkerContracts = {
  parse: { input: csvParseSchema, output: csvPageSchema },
  page: { input: csvPageRequestSchema, output: csvPageSchema },
} satisfies MethodContracts<CsvMethods>
export const CSV_PAGE_SIZE = 100
export const CSV_COLUMN_LIMIT = 200
