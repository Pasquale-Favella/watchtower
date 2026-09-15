import { writeFile, mkdir, readdir, open, stat, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import type { ProjectSummary, TaskCategory } from './pipeline/types.js'
import { CATEGORY_LABELS } from './pipeline/types.js'
import type { LedgerStore } from './store/ledger.js'
import { convertCost, getActiveCurrency, roundForActiveCurrency } from './fx.js'
import type { ExportResult } from '../shared/schemas/export.js'

export type { ExportResult } from '../shared/schemas/export.js'

/**
 * CSV/JSON export bridge (ADR 0009 seam for ADR 0013's Export pane). Costs
 * are read from the USD-anchored store and converted to the SELECTED display
 * currency at export time — the store is never rewritten. Mirrors the
 * reference app's export (one-table-per-file CSV folder with the
 * `.watchtower-export` marker; JSON schema `watchtower.export.v1`) so the
 * two surfaces line up.
 */

function escCsv(s: string): string {
  const sanitized = /^[\t\r=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number | undefined>

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0]!)
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 10000) / 100 : 0
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

function buildDailyRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const daily: Record<string, DailyAgg> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        if (!daily[day]) {
          daily[day] = { cost: 0, savings: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
        }
        daily[day]!.sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          daily[day]!.cost += call.costUSD
          daily[day]!.savings += call.savingsUSD ?? 0
          daily[day]!.calls++
          daily[day]!.input += call.usage.inputTokens
          daily[day]!.output += call.usage.outputTokens
          daily[day]!.cacheRead += call.usage.cacheReadInputTokens
          daily[day]!.cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  const currency = getActiveCurrency(store)
  const { code } = currency
  return Object.entries(daily).sort().map(([date, d]) => ({
    Date: date,
    [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost, currency), currency),
    [`Saved (${code})`]: roundForActiveCurrency(convertCost(d.savings, currency), currency),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildRecordRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const currency = getActiveCurrency(store)
  const rows: Row[] = []
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

function buildActivityRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const catTotals: Record<string, { turns: number; cost: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
        const bucket = catTotals[cat] ?? { turns: 0, cost: 0 }
        bucket.turns += d.turns
        bucket.cost += d.costUSD
        catTotals[cat] = bucket
      }
    }
  }
  const totalCost = Object.values(catTotals).reduce((s, d) => s + d.cost, 0)
  const currency = getActiveCurrency(store)
  const { code } = currency
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      Activity: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost, currency), currency),
      'Share (%)': pct(d.cost, totalCost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const modelTotals: Record<string, { calls: number; cost: number; savings: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        const bucket = modelTotals[model] ?? { calls: 0, cost: 0, savings: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        bucket.calls += d.calls
        bucket.cost += d.costUSD
        bucket.savings += d.savingsUSD
        bucket.input += d.tokens.inputTokens
        bucket.output += d.tokens.outputTokens
        bucket.cacheRead += d.tokens.cacheReadInputTokens ?? 0
        bucket.cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
        modelTotals[model] = bucket
      }
    }
  }
  const totalCost = Object.values(modelTotals).reduce((s, d) => s + d.cost, 0)
  const currency = getActiveCurrency(store)
  const { code } = currency
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings))
    .map(([model, d]) => ({
      Model: model,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost, currency), currency),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(d.savings, currency), currency),
      'Share (%)': pct(d.cost, totalCost),
      'API Calls': d.calls,
      'Input Tokens': d.input,
      'Output Tokens': d.output,
      'Cache Read Tokens': d.cacheRead,
      'Cache Write Tokens': d.cacheWrite,
    }))
}

function buildToolRows(projects: ProjectSummary[]): Row[] {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, d] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(toolTotals).reduce((s, n) => s + n, 0)
  return Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({ Tool: tool, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildMcpRows(projects: ProjectSummary[]): Row[] {
  const mcpTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [server, d] of Object.entries(session.mcpBreakdown)) {
        mcpTotals[server] = (mcpTotals[server] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(mcpTotals).reduce((s, n) => s + n, 0)
  return Object.entries(mcpTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([server, calls]) => ({ Server: server, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildBashRows(projects: ProjectSummary[]): Row[] {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, d] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(bashTotals).reduce((s, n) => s + n, 0)
  return Object.entries(bashTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd, calls]) => ({ Command: cmd, Calls: calls, 'Share (%)': pct(calls, total) }))
}

function buildProjectRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const currency = getActiveCurrency(store)
  const { code } = currency
  const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  return projects
    .slice()
    .sort((a, b) => (b.totalCostUSD + b.totalSavingsUSD) - (a.totalCostUSD + a.totalSavingsUSD))
    .map(p => ({
      Project: p.projectPath,
      repoUrl: p.repoUrl ?? undefined,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(p.totalCostUSD, currency), currency),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(p.totalSavingsUSD, currency), currency),
      [`Avg/Session (${code})`]: p.sessions.length > 0 ? roundForActiveCurrency(convertCost(p.totalCostUSD / p.sessions.length, currency), currency) : '',
      'Share (%)': pct(p.totalCostUSD, total),
      'API Calls': p.totalApiCalls,
      Sessions: p.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectSummary[], store: LedgerStore): Row[] {
  const currency = getActiveCurrency(store)
  const { code } = currency
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      const models = new Set(
        s.turns.flatMap(turn => turn.assistantCalls.map(call => call.model).filter(Boolean)),
      )
      rows.push({
        Project: p.projectPath,
        repoUrl: s.repoUrl ?? p.repoUrl ?? undefined,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(s.totalCostUSD, currency), currency),
        [`Saved (${code})`]: roundForActiveCurrency(convertCost(s.totalSavingsUSD, currency), currency),
        'API Calls': s.apiCalls,
        Turns: s.turns.length,
        model: models.size === 1 ? [...models][0] : undefined,
      })
    }
  }
  return rows.sort((a, b) => ((b[`Cost (${code})`] as number) + (b[`Saved (${code})`] as number)) - ((a[`Cost (${code})`] as number) + (a[`Saved (${code})`] as number)))
}

function buildReadme(store: LedgerStore): string {
  const { code } = getActiveCurrency(store)
  return [
    'Watchtower Usage Export',
    '========================',
    '',
    `Generated: ${new Date().toISOString()}`,
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

/// Sentinel file dropped into every folder we create so we can safely overwrite an older
/// export without ever deleting a user's unrelated files by accident.
const EXPORT_MARKER_FILE = '.watchtower-export'

async function isExportFolder(path: string): Promise<boolean> {
  const markerStat = await stat(join(path, EXPORT_MARKER_FILE)).catch(() => null)
  return markerStat?.isFile() ?? false
}

async function clearExportFolder(path: string): Promise<void> {
  const entries = await readdir(path)
  for (const entry of entries) {
    await rm(join(path, entry), { recursive: true, force: true })
  }
}

/** Writes a folder of one-table-per-file CSVs in the selected display
 * currency (re-read from the store at export time, so the file always
 * reflects the currency that was active when the export ran). The outputPath
 * is treated as a directory (a trailing `.csv` is stripped). Refuses to
 * delete a pre-existing file or a non-export folder, so a typo can never
 * wipe a user's unrelated files. */
export async function exportCsv(projects: ProjectSummary[], outputPath: string, store: LedgerStore): Promise<string> {
  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) {
    folder = folder.slice(0, -4)
  }

  const existingStat = await stat(folder).catch(() => null)
  if (existingStat?.isFile()) {
    throw new Error(`Refusing to overwrite existing file at ${folder}. Pass a directory path instead.`)
  }
  if (existingStat?.isDirectory()) {
    if (!(await isExportFolder(folder))) {
      throw new Error(
        `Refusing to reuse non-empty directory ${folder}: no ${EXPORT_MARKER_FILE} marker. ` +
        `Delete it manually or pick a different destination.`
      )
    }
    await clearExportFolder(folder)
  }
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, EXPORT_MARKER_FILE), '', 'utf-8')

  await writeFile(join(folder, 'README.txt'), buildReadme(store), 'utf-8')
  await writeFile(join(folder, 'daily.csv'), rowsToCsv(buildDailyRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'activity.csv'), rowsToCsv(buildActivityRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'models.csv'), rowsToCsv(buildModelRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'records.csv'), rowsToCsv(buildRecordRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(projects, store)), 'utf-8')
  await writeFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(projects)), 'utf-8')
  await writeFile(join(folder, 'mcp.csv'), rowsToCsv(buildMcpRows(projects)), 'utf-8')
  await writeFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(projects)), 'utf-8')

  return folder
}

/** Writes a single JSON file (schema `watchtower.export.v1`) whose cost
 * columns are converted to the selected display currency, with the active
 * currency carried in the payload's `currency` block. */
export async function exportJson(projects: ProjectSummary[], outputPath: string, store: LedgerStore): Promise<string> {
  const currency = getActiveCurrency(store)

  const data = {
    schema: 'watchtower.export.v1',
    generated: new Date().toISOString(),
    currency: { code: currency.code, symbol: currency.symbol, rate: currency.rate },
    daily: buildDailyRows(projects, store),
    activity: buildActivityRows(projects, store),
    models: buildModelRows(projects, store),
    projects: buildProjectRows(projects, store),
    sessions: buildSessionRows(projects, store),
    records: buildRecordRows(projects, store),
    tools: buildToolRows(projects),
    mcp: buildMcpRows(projects),
    shellCommands: buildBashRows(projects),
  }

  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  const existing = await stat(target).catch(() => null)
  if (existing?.isFile()) {
    const fh = await open(target, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const head = buf.toString('utf-8', 0, bytesRead)
      if (!head.includes('"schema": "watchtower.export.v')) {
        throw new Error(
          `Refusing to overwrite ${target}: file does not look like a watchtower export. ` +
          `Delete it manually or pick a different destination.`
        )
      }
    } finally {
      await fh.close()
    }
  }
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to overwrite directory at ${target}. Pass a file path instead.`)
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data, null, 2), 'utf-8')
  return target
}
