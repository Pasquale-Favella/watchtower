import type { ActiveCurrency } from '../shared/schemas/fx.js'

export type ExportRow = Record<string, string | number | undefined>
export type ExportFileContent = { readonly name: string; readonly contents: string }

function escCsv(value: string): string {
  const sanitized = /^[\t\r=+\-@]/.test(value) ? `'${value}` : value
  return sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')
    ? `"${sanitized.replace(/"/g, '""')}"`
    : sanitized
}

function rowsToCsv(rows: ExportRow[]): string {
  if (rows.length === 0) return ''
  const firstRow = rows[0]
  if (!firstRow) return ''
  const headers = Object.keys(firstRow)
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) lines.push(headers.map(header => escCsv(String(row[header] ?? ''))).join(','))
  return `${lines.join('\n')}\n`
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
    ...tables.map(([name, rows]) => ({ name, contents: rowsToCsv(rows) })),
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
