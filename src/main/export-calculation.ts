import type { ActiveCurrency } from '../shared/schemas/fx.js'
import { convertCost, roundForActiveCurrency } from './fx-calculation.js'
import type { ProjectSummary, TaskCategory } from './pipeline/types.js'
import { CATEGORY_LABELS } from './pipeline/types.js'

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

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10000) / 100 : 0
}

type DailyAgg = {
  cost: number
  savings: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

function buildDailyRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const daily: Record<string, DailyAgg> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        const dayAgg = (daily[day] ??= {
          cost: 0,
          savings: 0,
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          sessions: new Set(),
        })
        dayAgg.sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          dayAgg.cost += call.costUSD
          dayAgg.savings += call.savingsUSD ?? 0
          dayAgg.calls++
          dayAgg.input += call.usage.inputTokens
          dayAgg.output += call.usage.outputTokens
          dayAgg.cacheRead += call.usage.cacheReadInputTokens
          dayAgg.cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  const { code } = currency
  return Object.entries(daily)
    .sort()
    .map(([date, row]) => ({
      Date: date,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(row.cost, currency), currency),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(row.savings, currency), currency),
      'API Calls': row.calls,
      Sessions: row.sessions.size,
      'Input Tokens': row.input,
      'Output Tokens': row.output,
      'Cache Read Tokens': row.cacheRead,
      'Cache Write Tokens': row.cacheWrite,
    }))
}

function buildRecordRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const rows: ExportRow[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          rows.push({
            project: project.projectPath,
            repoUrl: session.repoUrl ?? project.repoUrl ?? undefined,
            sessionId: session.sessionId,
            timestamp: call.timestamp || turn.timestamp || undefined,
            category: turn.category,
            provider: call.provider,
            model: call.model || undefined,
            inputTokens: call.usage.inputTokens,
            outputTokens: call.usage.outputTokens,
            reasoningTokens: call.usage.reasoningTokens,
            cacheWriteTokens: call.usage.cacheCreationInputTokens,
            cacheReadTokens: Math.max(call.usage.cacheReadInputTokens, call.usage.cachedInputTokens),
            cost: roundForActiveCurrency(convertCost(call.costUSD, currency), currency),
            savings: roundForActiveCurrency(convertCost(call.savingsUSD ?? 0, currency), currency),
          })
        }
      }
    }
  }
  return rows
}

function buildActivityRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const totals: Record<string, { turns: number; cost: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [category, value] of Object.entries(session.categoryBreakdown)) {
        const bucket = totals[category] ?? { turns: 0, cost: 0 }
        bucket.turns += value.turns
        bucket.cost += value.costUSD
        totals[category] = bucket
      }
    }
  }
  const totalCost = Object.values(totals).reduce((sum, value) => sum + value.cost, 0)
  const { code } = currency
  return Object.entries(totals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([category, value]) => ({
      Activity: CATEGORY_LABELS[category as TaskCategory] ?? category,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(value.cost, currency), currency),
      'Share (%)': pct(value.cost, totalCost),
      Turns: value.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const totals: Record<
    string,
    {
      calls: number
      cost: number
      savings: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  > = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, value] of Object.entries(session.modelBreakdown)) {
        const bucket = totals[model] ?? {
          calls: 0,
          cost: 0,
          savings: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }
        bucket.calls += value.calls
        bucket.cost += value.costUSD
        bucket.savings += value.savingsUSD
        bucket.input += value.tokens.inputTokens
        bucket.output += value.tokens.outputTokens
        bucket.cacheRead += value.tokens.cacheReadInputTokens ?? 0
        bucket.cacheWrite += value.tokens.cacheCreationInputTokens ?? 0
        totals[model] = bucket
      }
    }
  }
  const totalCost = Object.values(totals).reduce((sum, value) => sum + value.cost, 0)
  const { code } = currency
  return Object.entries(totals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => b.cost + b.savings - (a.cost + a.savings))
    .map(([model, value]) => ({
      Model: model,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(value.cost, currency), currency),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(value.savings, currency), currency),
      'Share (%)': pct(value.cost, totalCost),
      'API Calls': value.calls,
      'Input Tokens': value.input,
      'Output Tokens': value.output,
      'Cache Read Tokens': value.cacheRead,
      'Cache Write Tokens': value.cacheWrite,
    }))
}

function buildToolRows(projects: ProjectSummary[]): ExportRow[] {
  const totals: Record<string, number> = {}
  for (const project of projects)
    for (const session of project.sessions)
      for (const [tool, value] of Object.entries(session.toolBreakdown))
        totals[tool] = (totals[tool] ?? 0) + value.calls
  const total = Object.values(totals).reduce((sum, calls) => sum + calls, 0)
  return Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({ Tool: tool, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildMcpRows(projects: ProjectSummary[]): ExportRow[] {
  const totals: Record<string, number> = {}
  for (const project of projects)
    for (const session of project.sessions)
      for (const [server, value] of Object.entries(session.mcpBreakdown))
        totals[server] = (totals[server] ?? 0) + value.calls
  const total = Object.values(totals).reduce((sum, calls) => sum + calls, 0)
  return Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .map(([server, calls]) => ({ Server: server, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildBashRows(projects: ProjectSummary[]): ExportRow[] {
  const totals: Record<string, number> = {}
  for (const project of projects)
    for (const session of project.sessions)
      for (const [command, value] of Object.entries(session.bashBreakdown))
        totals[command] = (totals[command] ?? 0) + value.calls
  const total = Object.values(totals).reduce((sum, calls) => sum + calls, 0)
  return Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .map(([command, calls]) => ({ Command: command, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildProjectRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const { code } = currency
  const total = projects.reduce((sum, project) => sum + project.totalCostUSD, 0)
  return projects
    .slice()
    .sort((a, b) => b.totalCostUSD + b.totalSavingsUSD - (a.totalCostUSD + a.totalSavingsUSD))
    .map(project => ({
      Project: project.projectPath,
      repoUrl: project.repoUrl ?? undefined,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(project.totalCostUSD, currency), currency),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(project.totalSavingsUSD, currency), currency),
      [`Avg/Session (${code})`]:
        project.sessions.length > 0
          ? roundForActiveCurrency(convertCost(project.totalCostUSD / project.sessions.length, currency), currency)
          : '',
      'Share (%)': pct(project.totalCostUSD, total),
      'API Calls': project.totalApiCalls,
      Sessions: project.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRow[] {
  const { code } = currency
  const rows: ExportRow[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const models = new Set(session.turns.flatMap(turn => turn.assistantCalls.map(call => call.model).filter(Boolean)))
      rows.push({
        Project: project.projectPath,
        repoUrl: session.repoUrl ?? project.repoUrl ?? undefined,
        'Session ID': session.sessionId,
        'Started At': session.firstTimestamp ?? '',
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(session.totalCostUSD, currency), currency),
        [`Saved (${code})`]: roundForActiveCurrency(convertCost(session.totalSavingsUSD, currency), currency),
        'API Calls': session.apiCalls,
        Turns: session.turns.length,
        model: models.size === 1 ? [...models][0] : undefined,
      })
    }
  }
  return rows.sort(
    (a, b) =>
      (b[`Cost (${code})`] as number) +
      (b[`Saved (${code})`] as number) -
      ((a[`Cost (${code})`] as number) + (a[`Saved (${code})`] as number)),
  )
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

function buildExportRows(projects: ProjectSummary[], currency: ActiveCurrency): ExportRows {
  return {
    daily: buildDailyRows(projects, currency),
    activity: buildActivityRows(projects, currency),
    models: buildModelRows(projects, currency),
    projects: buildProjectRows(projects, currency),
    sessions: buildSessionRows(projects, currency),
    records: buildRecordRows(projects, currency),
    tools: buildToolRows(projects),
    mcp: buildMcpRows(projects),
    shellCommands: buildBashRows(projects),
  }
}

export function buildCsvExportFiles(
  projects: ProjectSummary[],
  currency: ActiveCurrency,
  generated: string,
): ExportFileContent[] {
  const rows = buildExportRows(projects, currency)
  return buildCsvExportFilesFromRows(rows, currency, generated)
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

export function buildJsonExport(projects: ProjectSummary[], currency: ActiveCurrency, generated: string): string {
  const rows = buildExportRows(projects, currency)
  return buildJsonExportFromRows(rows, currency, generated)
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
