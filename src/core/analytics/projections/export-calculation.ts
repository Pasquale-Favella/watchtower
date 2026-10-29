import Papa from 'papaparse'

import type { ActiveCurrency } from '@/shared/schemas/fx.js'

export type ExportRow = Record<string, string | number | undefined>
export type ExportFileContent = { readonly name: string; readonly contents: string }

const CSV_FORMULA_PREFIX = /^[\t\r\n=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/

/** Canonical header line per CSV file, kept in one place so tables with no
 * rows still export their headers instead of 0-byte files. A parity test
 * pins these against the live row builders to catch key drift. */
export const CSV_TABLE_HEADERS: Record<string, readonly string[] | ((code: string) => readonly string[])> = {
  'daily.csv': code => [
    'Date',
    `Cost (${code})`,
    `Saved (${code})`,
    'API Calls',
    'Sessions',
    'Input Tokens',
    'Output Tokens',
    'Cache Read Tokens',
    'Cache Write Tokens',
  ],
  'activity.csv': code => ['Activity', `Cost (${code})`, 'Share (%)', 'Turns'],
  'models.csv': code => [
    'Model',
    `Cost (${code})`,
    `Saved (${code})`,
    'Share (%)',
    'API Calls',
    'Input Tokens',
    'Output Tokens',
    'Cache Read Tokens',
    'Cache Write Tokens',
  ],
  'records.csv': [
    'project',
    'repoUrl',
    'sessionId',
    'timestamp',
    'category',
    'provider',
    'model',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheWriteTokens',
    'cacheReadTokens',
    'cost',
    'savings',
  ],
  'projects.csv': code => [
    'Project',
    'repoUrl',
    `Cost (${code})`,
    `Saved (${code})`,
    `Avg/Session (${code})`,
    'Share (%)',
    'API Calls',
    'Sessions',
  ],
  'sessions.csv': code => [
    'Project',
    'repoUrl',
    'Session ID',
    'Started At',
    `Cost (${code})`,
    `Saved (${code})`,
    'API Calls',
    'Turns',
    'model',
  ],
  'tools.csv': ['Tool', 'Calls', 'Share (%)'],
  'mcp.csv': ['Server', 'Calls', 'Share (%)'],
  'shell-commands.csv': ['Command', 'Calls', 'Share (%)'],
}

function rowsToCsv(rows: ExportRow[], headers?: readonly string[]): string {
  const columnNames = rows.length > 0 ? Object.keys(rows[0]!) : (headers ?? [])
  if (columnNames.length === 0) return ''
  const csv = Papa.unparse(
    {
      fields: Array.from(columnNames),
      data: rows.map(row => columnNames.map(header => String(row[header] ?? ''))),
    },
    { newline: '\n', escapeFormulae: CSV_FORMULA_PREFIX },
  )
  return csv.endsWith('\n') ? csv : `${csv}\n`
}

function buildReadme(currency: ActiveCurrency, generated: string): string {
  const { code } = currency
  return [
    'Watchtower Usage Export',
    '========================',
    '',
    `Generated: ${generated}`,
    `Currency:  ${code}`,
    '',
    'Files',
    '-----',
    '  daily.csv             Day-by-day breakdown.',
    '  activity.csv          Time spent per task category (Coding, Debugging, Exploration, etc.).',
    '  models.csv            Spend per model with token totals and cache usage.',
    '  records.csv           One row per API call.',
    '  projects.csv          Spend per project folder.',
    '  sessions.csv          One row per session.',
    '  tools.csv             Tool invocations and share.',
    '  mcp.csv               MCP server invocations and share.',
    '  shell-commands.csv    Shell commands executed via Bash tool.',
    '',
    'Notes',
    '-----',
    `  Every cost column is already converted to the active currency (${code}). Tokens are raw`,
    '  integer counts from provider telemetry. Share (%) is relative to the table total.',
    '  repoUrl is the git origin URL when the project path is a git checkout with a',
    '  configured origin, otherwise empty (CSV) / absent (JSON).',
    '',
  ].join('\n')
}

export type ExportRows = {
  daily: ExportRow[]
  activity: ExportRow[]
  models: ExportRow[]
  projects: ExportRow[]
  sessions: ExportRow[]
  records: ExportRow[]
  tools: ExportRow[]
  mcp: ExportRow[]
  shellCommands: ExportRow[]
}

export function buildCsvExportFilesFromRows(
  rows: ExportRows,
  currency: ActiveCurrency,
  generated: string,
): ExportFileContent[] {
  const tables: Array<[string, ExportRow[]]> = [
    ['daily.csv', rows.daily],
    ['activity.csv', rows.activity],
    ['models.csv', rows.models],
    ['records.csv', rows.records],
    ['projects.csv', rows.projects],
    ['sessions.csv', rows.sessions],
    ['tools.csv', rows.tools],
    ['mcp.csv', rows.mcp],
    ['shell-commands.csv', rows.shellCommands],
  ]
  return [
    { name: 'README.txt', contents: buildReadme(currency, generated) },
    ...tables.map(([name, rows]) => {
      const template = CSV_TABLE_HEADERS[name]
      const headers = typeof template === 'function' ? template(currency.code) : template
      return { name, contents: rowsToCsv(rows, headers) }
    }),
  ]
}

export function buildJsonExportFromRows(rows: ExportRows, currency: ActiveCurrency, generated: string): string {
  return JSON.stringify(
    {
      schema: 'watchtower.export.v1',
      generated,
      currency: { code: currency.code, symbol: currency.symbol, rate: currency.rate },
      ...rows,
    },
    null,
    2,
  )
}
