import type { ActiveCurrency } from '../shared/schemas/fx.js'
import { canonicalSessionProject } from './canonical-session-project.js'
import type { ExportRow, ExportRows } from './export-calculation.js'
import { convertCost, roundForActiveCurrency } from './fx-calculation.js'
import { getShortModelName } from './pipeline/model-names.js'
import {
  calculateRepricedCostResult,
  createPricingConfigLookup,
  type PricingCatalogue,
  resolveModelNameAlias,
} from './pipeline/pricing-calculation.js'
import { CATEGORY_LABELS, type TaskCategory } from './pipeline/types.js'
import type { LedgerExportData } from './store/export-read-projections.js'

type SessionFact = LedgerExportData['sessions'][number]
type TurnFact = LedgerExportData['turns'][number]
type CallFact = LedgerExportData['calls'][number]
type PricedCall = {
  readonly row: CallFact
  readonly model: string
  readonly displayModel: string
  readonly cost: number
  readonly savings: number
}
type GroupedTurn = { readonly row: TurnFact; readonly calls: PricedCall[]; readonly firstMs: number }
type AdmittedSession = {
  readonly row: SessionFact
  readonly projectKey: string
  readonly projectPath: string
  readonly turns: GroupedTurn[]
  repoUrl?: string
}
type ProjectAggregate = {
  readonly projectPath: string
  readonly sessions: AdmittedSession[]
  repoUrl?: string
  cost: number
  savings: number
  calls: number
}

export type ExportTableData = { readonly projects: ProjectAggregate[] }

type DailyAggregate = {
  cost: number
  savings: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

type ModelAggregate = {
  calls: number
  cost: number
  savings: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const ALL_TIME_MIN = -8.64e15
const ALL_TIME_MAX = 8.64e15

function compositeKey(sourceId: number, sessionId: string, turnIndex?: number): string {
  return `${sourceId}\0${sessionId}${turnIndex === undefined ? '' : `\0${turnIndex}`}`
}

function timestampMs(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function currencyValue(value: number, currency: ActiveCurrency): number {
  return roundForActiveCurrency(convertCost(value, currency), currency)
}

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10000) / 100 : 0
}

function sortedEntries<T>(values: Record<string, T>, compare: (left: T, right: T) => number): [string, T][] {
  return Object.entries(values).sort(([, left], [, right]) => compare(left, right))
}

function admitData(
  data: LedgerExportData,
  catalogue: PricingCatalogue,
): { projects: ProjectAggregate[]; unpricedModels: readonly string[] } {
  const pricing = createPricingConfigLookup(data.aliases, data.overrides)
  const callsByTurn = new Map<string, PricedCall[]>()
  const unpricedModels = new Set<string>()

  for (const row of data.calls) {
    const model = pricing.resolveAlias(row.model)
    const result = calculateRepricedCostResult(catalogue, pricing, {
      model: row.model,
      effectiveModel: model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheWriteTokens: row.cacheCreationInputTokens,
      cacheReadTokens: Math.max(row.cacheReadInputTokens, row.cachedInputTokens),
      webSearchRequests: row.webSearchRequests,
      speed: row.speed,
      recordedCost: row.baseCostUSD,
    })
    if (!result.priced) unpricedModels.add(model)
    const key = compositeKey(row.sourceId, row.sessionId, row.turnIndex)
    const calls = callsByTurn.get(key) ?? []
    calls.push({
      row,
      model,
      displayModel:
        row.provider === 'devin' ? model : getShortModelName(model, name => resolveModelNameAlias(catalogue, name)),
      cost: result.cost,
      savings: row.savingsUSD > 0 ? row.savingsUSD : 0,
    })
    callsByTurn.set(key, calls)
  }

  const sessionsByKey = new Map<string, SessionFact>()
  for (const session of data.sessions) sessionsByKey.set(compositeKey(session.sourceId, session.sessionId), session)

  const sessionsWithTurns = new Map<string, AdmittedSession>()
  for (const turn of data.turns) {
    const key = compositeKey(turn.sourceId, turn.sessionId)
    const session = sessionsByKey.get(key)
    if (!session) continue
    let admitted = sessionsWithTurns.get(key)
    if (!admitted) {
      const identity = canonicalSessionProject(session, session.sourceProvider)
      admitted = {
        row: session,
        projectKey: identity.projectKey,
        projectPath: identity.projectPath ?? session.workingDirectory ?? session.project ?? '',
        turns: [],
        ...(session.repoUrl ? { repoUrl: session.repoUrl } : {}),
      }
      sessionsWithTurns.set(key, admitted)
    }
    const calls = callsByTurn.get(compositeKey(turn.sourceId, turn.sessionId, turn.turnIndex)) ?? []
    calls.sort((left, right) => left.row.callIndex - right.row.callIndex)
    const firstMs = timestampMs(calls[0]?.row.timestamp ?? turn.timestamp)
    admitted.turns.push({ row: turn, calls, firstMs })
  }

  const sessions = [...sessionsWithTurns.values()].flatMap(session => {
    const turns = session.turns
      .sort((left, right) => left.firstMs - right.firstMs || left.row.timestamp.localeCompare(right.row.timestamp))
      .filter(
        turn =>
          turn.calls.length > 0 &&
          Number.isFinite(turn.firstMs) &&
          turn.firstMs >= ALL_TIME_MIN &&
          turn.firstMs <= ALL_TIME_MAX,
      )
    return turns.length > 0 ? [{ ...session, turns }] : []
  })
  sessions.sort((left, right) => left.row.sessionId.localeCompare(right.row.sessionId))

  const projectsByKey = new Map<string, ProjectAggregate>()
  for (const session of sessions) {
    let project = projectsByKey.get(session.projectKey)
    if (!project) {
      project = {
        projectPath: session.projectPath,
        sessions: [],
        cost: 0,
        savings: 0,
        calls: 0,
      }
      projectsByKey.set(session.projectKey, project)
    }
    project.sessions.push(session)
    if (!project.repoUrl && session.repoUrl) project.repoUrl = session.repoUrl
    let sessionCost = 0
    let sessionSavings = 0
    let sessionCalls = 0
    for (const turn of session.turns) {
      for (const call of turn.calls) {
        sessionCost += call.cost
        sessionSavings += call.savings
        sessionCalls++
      }
    }
    project.cost += sessionCost
    project.savings += sessionSavings
    project.calls += sessionCalls
  }
  return { projects: [...projectsByKey.values()], unpricedModels: [...unpricedModels] }
}

function buildDailyRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const daily: Record<string, DailyAggregate> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.row.timestamp) continue
        const day = turn.row.timestamp.slice(0, 10)
        const aggregate = (daily[day] ??= {
          cost: 0,
          savings: 0,
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          sessions: new Set(),
        })
        aggregate.sessions.add(session.row.sessionId)
        for (const call of turn.calls) {
          aggregate.cost += call.cost
          aggregate.savings += call.savings
          aggregate.calls++
          aggregate.input += call.row.inputTokens
          aggregate.output += call.row.outputTokens
          aggregate.cacheRead += call.row.cacheReadInputTokens
          aggregate.cacheWrite += call.row.cacheCreationInputTokens
        }
      }
    }
  }
  const code = currency.code
  return Object.entries(daily)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({
      Date: date,
      [`Cost (${code})`]: currencyValue(row.cost, currency),
      [`Saved (${code})`]: currencyValue(row.savings, currency),
      'API Calls': row.calls,
      Sessions: row.sessions.size,
      'Input Tokens': row.input,
      'Output Tokens': row.output,
      'Cache Read Tokens': row.cacheRead,
      'Cache Write Tokens': row.cacheWrite,
    }))
}

function buildRecordRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const rows: ExportRow[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.calls) {
          rows.push({
            project: project.projectPath,
            repoUrl: session.repoUrl ?? project.repoUrl ?? undefined,
            sessionId: session.row.sessionId,
            timestamp: call.row.timestamp || turn.row.timestamp || undefined,
            category: turn.row.category,
            provider: call.row.provider,
            model: call.model || undefined,
            inputTokens: call.row.inputTokens,
            outputTokens: call.row.outputTokens,
            reasoningTokens: call.row.reasoningTokens,
            cacheWriteTokens: call.row.cacheCreationInputTokens,
            cacheReadTokens: Math.max(call.row.cacheReadInputTokens, call.row.cachedInputTokens),
            cost: currencyValue(call.cost, currency),
            savings: currencyValue(call.savings, currency),
          })
        }
      }
    }
  }
  return rows
}

function buildActivityRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const totals: Record<string, { turns: number; cost: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionTotals: Record<string, { turns: number; cost: number }> = {}
      for (const turn of session.turns) {
        const category = turn.row.category
        const aggregate = (sessionTotals[category] ??= { turns: 0, cost: 0 })
        aggregate.turns++
        for (const call of turn.calls) aggregate.cost += call.cost
      }
      for (const [category, value] of Object.entries(sessionTotals)) {
        const aggregate = (totals[category] ??= { turns: 0, cost: 0 })
        aggregate.turns += value.turns
        aggregate.cost += value.cost
      }
    }
  }
  const totalCost = Object.values(totals).reduce((sum, value) => sum + value.cost, 0)
  const code = currency.code
  return sortedEntries(totals, (left, right) => right.cost - left.cost).map(([category, value]) => ({
    Activity: CATEGORY_LABELS[category as TaskCategory] ?? category,
    [`Cost (${code})`]: currencyValue(value.cost, currency),
    'Share (%)': pct(value.cost, totalCost),
    Turns: value.turns,
  }))
}

function buildModelRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const totals: Record<string, ModelAggregate> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionModels: Record<string, ModelAggregate> = {}
      for (const turn of session.turns) {
        for (const call of turn.calls) {
          const model = call.displayModel
          const aggregate = (sessionModels[model] ??= {
            calls: 0,
            cost: 0,
            savings: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          })
          aggregate.calls++
          aggregate.cost += call.cost
          aggregate.savings += call.savings
          aggregate.input += call.row.inputTokens
          aggregate.output += call.row.outputTokens
          aggregate.cacheRead += call.row.cacheReadInputTokens
          aggregate.cacheWrite += call.row.cacheCreationInputTokens
        }
      }
      for (const [model, value] of Object.entries(sessionModels)) {
        const aggregate = (totals[model] ??= {
          calls: 0,
          cost: 0,
          savings: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })
        aggregate.calls += value.calls
        aggregate.cost += value.cost
        aggregate.savings += value.savings
        aggregate.input += value.input
        aggregate.output += value.output
        aggregate.cacheRead += value.cacheRead
        aggregate.cacheWrite += value.cacheWrite
      }
    }
  }
  const totalCost = Object.values(totals).reduce((sum, value) => sum + value.cost, 0)
  const code = currency.code
  return sortedEntries(totals, (left, right) => right.cost + right.savings - (left.cost + left.savings))
    .filter(([model]) => model !== '<synthetic>')
    .map(([model, value]) => ({
      Model: model,
      [`Cost (${code})`]: currencyValue(value.cost, currency),
      [`Saved (${code})`]: currencyValue(value.savings, currency),
      'Share (%)': pct(value.cost, totalCost),
      'API Calls': value.calls,
      'Input Tokens': value.input,
      'Output Tokens': value.output,
      'Cache Read Tokens': value.cacheRead,
      'Cache Write Tokens': value.cacheWrite,
    }))
}

function buildCountRows(
  projects: ProjectAggregate[],
  select: (call: PricedCall) => readonly string[],
  label: 'Tool' | 'Server' | 'Command',
): ExportRow[] {
  const totals: Record<string, number> = {}
  for (const project of projects)
    for (const session of project.sessions)
      for (const turn of session.turns)
        for (const call of turn.calls) for (const name of select(call)) totals[name] = (totals[name] ?? 0) + 1
  const total = Object.values(totals).reduce((sum, count) => sum + count, 0)
  return sortedEntries(totals, (left, right) => right - left).map(([name, count]) => ({
    [label]: name,
    Calls: count,
    'Share (%)': pct(count, total),
  }))
}

function toolNames(call: PricedCall): string[] {
  return call.row.tools.filter(name => !name.startsWith('mcp__'))
}

function mcpNames(call: PricedCall): string[] {
  return call.row.mcpTools.map(name => name.split('__')[1] ?? name)
}

function buildProjectRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const total = projects.reduce((sum, project) => sum + project.cost, 0)
  const code = currency.code
  return projects
    .slice()
    .sort((left, right) => right.cost + right.savings - (left.cost + left.savings))
    .map(project => ({
      Project: project.projectPath,
      repoUrl: project.repoUrl ?? undefined,
      [`Cost (${code})`]: currencyValue(project.cost, currency),
      [`Saved (${code})`]: currencyValue(project.savings, currency),
      [`Avg/Session (${code})`]:
        project.sessions.length > 0 ? currencyValue(project.cost / project.sessions.length, currency) : '',
      'Share (%)': pct(project.cost, total),
      'API Calls': project.calls,
      Sessions: project.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectAggregate[], currency: ActiveCurrency): ExportRow[] {
  const code = currency.code
  const rows: ExportRow[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const models = new Set(session.turns.flatMap(turn => turn.calls.map(call => call.model).filter(Boolean)))
      let cost = 0
      let savings = 0
      let apiCalls = 0
      let firstTimestamp = ''
      for (const turn of session.turns) {
        for (const call of turn.calls) {
          cost += call.cost
          savings += call.savings
          apiCalls++
          if (!firstTimestamp || call.row.timestamp < firstTimestamp) firstTimestamp = call.row.timestamp
        }
      }
      rows.push({
        Project: project.projectPath,
        repoUrl: session.repoUrl ?? project.repoUrl ?? undefined,
        'Session ID': session.row.sessionId,
        'Started At': firstTimestamp || session.turns[0]?.row.timestamp || '',
        [`Cost (${code})`]: currencyValue(cost, currency),
        [`Saved (${code})`]: currencyValue(savings, currency),
        'API Calls': apiCalls,
        Turns: session.turns.length,
        model: models.size === 1 ? [...models][0] : undefined,
      })
    }
  }
  return rows.sort(
    (left, right) =>
      (right[`Cost (${code})`] as number) +
      (right[`Saved (${code})`] as number) -
      ((left[`Cost (${code})`] as number) + (left[`Saved (${code})`] as number)),
  )
}

export function calculateExportData(
  data: LedgerExportData,
  catalogue: PricingCatalogue,
): { data: ExportTableData; sessionCount: number; unpricedModels: readonly string[] } {
  const { projects, unpricedModels } = admitData(data, catalogue)
  return {
    data: { projects },
    sessionCount: projects.reduce((sum, project) => sum + project.sessions.length, 0),
    unpricedModels,
  }
}

export function buildExportRows(data: ExportTableData, currency: ActiveCurrency): ExportRows {
  const projects = data.projects
  return {
    daily: buildDailyRows(projects, currency),
    activity: buildActivityRows(projects, currency),
    models: buildModelRows(projects, currency),
    projects: buildProjectRows(projects, currency),
    sessions: buildSessionRows(projects, currency),
    records: buildRecordRows(projects, currency),
    tools: buildCountRows(projects, toolNames, 'Tool'),
    mcp: buildCountRows(projects, mcpNames, 'Server'),
    shellCommands: buildCountRows(projects, call => call.row.bashCommands, 'Command'),
  }
}
