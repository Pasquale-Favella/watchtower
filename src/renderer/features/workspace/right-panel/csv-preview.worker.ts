import * as Effect from 'effect/Effect'
import Papa from 'papaparse'

import {
  CSV_COLUMN_LIMIT,
  CSV_PAGE_SIZE,
  type CsvMethods,
  type CsvPage,
  csvWorkerContracts,
} from './csv-preview-protocol.js'
import { serveWorker } from './file-previews/office/worker-rpc.js'

let rows: string[][] = []

function page(offset: number): CsvPage {
  const headers = rows[0] ?? []
  return {
    headers: headers.slice(0, CSV_COLUMN_LIMIT),
    rows: rows.slice(offset + 1, offset + CSV_PAGE_SIZE + 1).map(row => row.slice(0, CSV_COLUMN_LIMIT)),
    offset,
    total: Math.max(0, rows.length - 1),
    columns: headers.length,
  }
}

Effect.runFork(
  serveWorker<CsvMethods>(csvWorkerContracts, {
    parse: input => {
      rows = Papa.parse<string[]>(input.content, { delimiter: input.delimiter, skipEmptyLines: true }).data
      return page(0)
    },
    page: input => page(input.offset),
  }),
)
