/**
 * Renderer fetch library (ADR 0005) — the renderer-side tripwire over
 * the preload's IPC surface. Every payload-bearing channel is `safeParse`d
 * against the same shared schema the main process validates against, so a
 * malformed payload becomes a `{ ok: false }` result the views render as an
 * error state instead of a crash or garbage. The wire contract is frozen: no
 * channel name, request shape, or payload byte changes here.
 */
import { z } from 'zod'

import {
  type CoachHarnessesResult,
  coachHarnessesResultSchema,
  type CoachInspectRequest,
  type CoachInspectResult,
  coachInspectResultSchema,
  type CoachRunRequest,
  type CoachRunResult,
  coachRunResultSchema,
} from '../../../../shared/schemas/agents.js'
import { type CadenceValue, cadenceValueSchema } from '../../../../shared/schemas/cadence.js'
import { type ComparePair, type ComparePayload, comparePayloadSchema } from '../../../../shared/schemas/compare.js'
import { type ExportResult, exportResultSchema } from '../../../../shared/schemas/export.js'
import {
  type ActiveCurrency,
  activeCurrencySchema,
  type CurrencyOption,
  currencyOptionSchema,
} from '../../../../shared/schemas/fx.js'
import {
  type PricingRefreshResult,
  pricingRefreshResultSchema,
  type ScanResult,
  scanResultSchema,
  type ScanStatus,
  scanStatusSchema,
  type SettingsInfo,
  settingsInfoSchema,
} from '../../../../shared/schemas/ipc.js'
import {
  type LedgerMcpConnection,
  ledgerMcpConnectionSchema,
  type LedgerMcpStartupMode,
  type LedgerMcpStatus,
  ledgerMcpStatusSchema,
} from '../../../../shared/schemas/ledger-mcp.js'
import {
  type ModelAlias,
  modelAliasSchema,
  type ModelsPayload,
  modelsPayloadSchema,
  type PriceOverride,
  priceOverrideSchema,
} from '../../../../shared/schemas/models.js'
import { type OptimizePayload, optimizePayloadSchema } from '../../../../shared/schemas/optimize.js'
import { type OverviewPayload, overviewPayloadSchema, type OverviewScope } from '../../../../shared/schemas/overview.js'
import { type PullRequestsPayload, pullRequestsPayloadSchema } from '../../../../shared/schemas/pull-requests.js'
import {
  type SkillsDismissalRequest,
  type SkillsDismissalResult,
  skillsDismissalResultSchema,
  type SkillsPayload,
  skillsPayloadSchema,
  type SkillsSaveRequest,
  type SkillsSaveResult,
  skillsSaveResultSchema,
  type SkillsThresholds,
} from '../../../../shared/schemas/skills.js'
import { type SpendPayload, spendPayloadSchema } from '../../../../shared/schemas/spend.js'
import {
  type AppVersion,
  appVersionSchema,
  type UpdateStatus,
  updateStatusSchema,
} from '../../../../shared/schemas/updates.js'
import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
  type ProjectRow,
  projectRowSchema,
  type SearchHit,
  searchHitSchema,
  type SessionDetail,
  sessionDetailSchema,
  type SessionPageResult,
  sessionPageResultSchema,
  type SessionRow,
  sessionRowSchema,
} from '../../../../shared/schemas/views.js'
import { type YieldPayload, yieldPayloadSchema } from '../../../../shared/schemas/yield.js'

/** The shared renderer error shape for an IPC payload: either validated data
 * or a human-readable message naming the channel and the failing field. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** `safeParse`s a raw IPC payload against its shared schema. Invalid payloads
 * become a visible error naming the channel and first failing field/path —
 * never garbage the views would render. */
export function parsePayload<T>(schema: z.ZodType<T>, label: string, raw: unknown): ApiResult<T> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, data: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length ? issue.path.join('.') : 'payload'
  const detail = issue ? issue.message : 'does not match the expected shape'
  return { ok: false, error: `Invalid ${label} payload (${where}: ${detail})` }
}

/** Runs an IPC invoke and safeParses its resolution; a rejected IPC call also
 * surfaces as a `{ ok: false }` result (never an unhandled rejection). */
export async function fetchPayload<T>(
  label: string,
  schema: z.ZodType<T>,
  invoke: () => Promise<unknown>,
): Promise<ApiResult<T>> {
  try {
    return parsePayload(schema, label, await invoke())
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The subscription-event tripwire (ADR 0005): broadcast channels carry
 * payloads too. A malformed broadcast is dropped and forwarded to the
 * Operational log with its label + location only (never contents) — a bad
 * `scan:progress` or `currency:changed` can't paint garbage, it just falls
 * back to the last good value. The forward never breaks rendering. */
export function parseEvent<T>(schema: z.ZodType<T>, label: string, raw: unknown): T | null {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length ? issue.path.join('.') : 'payload'
  forwardTripwireNotice(label, where)
  return null
}

function forwardTripwireNotice(label: string, location: string): void {
  try {
    const api = (
      globalThis as unknown as { api?: { notifyNotice?: (label: string, location: string) => Promise<unknown> } }
    ).api
    void api?.notifyNotice?.(label, location)?.catch(() => {})
  } catch {
    /* logging must never break rendering */
  }
}

const okEnvelopeSchema = z.object({ ok: z.literal(true) })
export type OkEnvelope = z.infer<typeof okEnvelopeSchema>

export function fetchScanStatus(): Promise<ApiResult<ScanStatus>> {
  return fetchPayload('scan status', scanStatusSchema, () => window.api.getScanStatus())
}

export function fetchViews(): Promise<ApiResult<DashboardViews | null>> {
  return fetchPayload('dashboard views', dashboardViewsSchema.nullable(), () => window.api.getViews())
}

export function fetchProjects(): Promise<ApiResult<ProjectRow[]>> {
  return fetchPayload('projects', z.array(projectRowSchema), () => window.api.getProjects())
}

export function fetchSessions(filter?: {
  project?: string
  since?: string
  until?: string
}): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('sessions', z.array(sessionRowSchema), () => window.api.getSessions(filter))
}

export function fetchSession(sessionId: string): Promise<ApiResult<SessionDetail | null>> {
  return fetchPayload('session detail', sessionDetailSchema.nullable(), () => window.api.getSession(sessionId))
}

export function fetchAnalytics(): Promise<ApiResult<AnalyticalViews | null>> {
  return fetchPayload('analytics', analyticalViewsSchema.nullable(), () => window.api.getAnalytics())
}

export function fetchOverview(scope: OverviewScope): Promise<ApiResult<OverviewPayload | null>> {
  return fetchPayload('overview', overviewPayloadSchema.nullable(), () => window.api.getOverview(scope))
}

export function fetchSessionRows(
  scope: OverviewScope,
  page?: { limit?: number; offset?: number },
): Promise<ApiResult<SessionRow[]>> {
  // The wire contract is frozen (ADR 0005): existing callers send exactly one
  // arg — the page rides only when explicitly requested.
  return fetchPayload('session rows', z.array(sessionRowSchema), () =>
    page === undefined ? window.api.getSessionRows(scope) : window.api.getSessionRows(scope, page),
  )
}

export function fetchSessionPage(
  scope: OverviewScope,
  query?: { query?: string; sort?: string; limit?: number; offset?: number; cursor?: string | null },
): Promise<ApiResult<SessionPageResult>> {
  // The wire contract is frozen (ADR 0005): this is a NEW channel, so the
  // `sessions:view` full-list shape stays untouched. The query rides only
  // when explicitly requested.
  return fetchPayload('session page', sessionPageResultSchema, () =>
    query === undefined ? window.api.getSessionPage(scope) : window.api.getSessionPage(scope, query),
  )
}

export function fetchPullRequests(scope: OverviewScope): Promise<ApiResult<PullRequestsPayload | null>> {
  return fetchPayload('pull requests', pullRequestsPayloadSchema.nullable(), () => window.api.getPullRequests(scope))
}

export function fetchSpend(
  scope: OverviewScope,
  page?: { flowLimit?: number },
): Promise<ApiResult<SpendPayload | null>> {
  return fetchPayload('spend', spendPayloadSchema.nullable(), () =>
    page === undefined ? window.api.getSpend(scope) : window.api.getSpend(scope, page),
  )
}

export function fetchModels(scope: OverviewScope): Promise<ApiResult<ModelsPayload | null>> {
  return fetchPayload('models', modelsPayloadSchema.nullable(), () => window.api.getModels(scope))
}

export function fetchCompare(scope: OverviewScope, pair?: ComparePair): Promise<ApiResult<ComparePayload | null>> {
  return fetchPayload('compare', comparePayloadSchema.nullable(), () => window.api.getCompare(scope, pair))
}

export function fetchOptimize(scope: OverviewScope): Promise<ApiResult<OptimizePayload | null>> {
  return fetchPayload('optimize', optimizePayloadSchema.nullable(), () => window.api.getOptimize(scope))
}

export function fetchYield(scope: OverviewScope): Promise<ApiResult<YieldPayload | null>> {
  return fetchPayload('yield', yieldPayloadSchema.nullable(), () => window.api.getYield(scope))
}

export function fetchSkills(
  scope: OverviewScope,
  thresholds?: SkillsThresholds,
): Promise<ApiResult<SkillsPayload | null>> {
  return fetchPayload('skills', skillsPayloadSchema.nullable(), () => window.api.getSkills(scope, thresholds))
}

export function fetchDismissSkill(request: SkillsDismissalRequest): Promise<ApiResult<SkillsDismissalResult>> {
  return fetchPayload('skills dismissal', skillsDismissalResultSchema, () => window.api.dismissSkill(request))
}

export function fetchSaveSkill(request: SkillsSaveRequest): Promise<ApiResult<SkillsSaveResult>> {
  return fetchPayload('skills save', skillsSaveResultSchema, () => window.api.saveSkill(request))
}

export function fetchModelAliases(): Promise<ApiResult<ModelAlias[]>> {
  return fetchPayload('model aliases', z.array(modelAliasSchema), () => window.api.getModelAliases())
}

export function fetchPriceOverrides(): Promise<ApiResult<PriceOverride[]>> {
  return fetchPayload('price overrides', z.array(priceOverrideSchema), () => window.api.getPriceOverrides())
}

export function fetchSettings(): Promise<ApiResult<SettingsInfo>> {
  return fetchPayload('settings', settingsInfoSchema, () => window.api.getSettings())
}

export function fetchClearData(): Promise<ApiResult<SettingsInfo>> {
  return fetchPayload('cleared settings', settingsInfoSchema, () => window.api.clearData())
}

export function fetchLedgerMcpStatus(): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP status', ledgerMcpStatusSchema, () => window.api.getLedgerMcpStatus())
}

export function fetchSetLedgerMcpStartupMode(mode: LedgerMcpStartupMode): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP startup mode', ledgerMcpStatusSchema, () => window.api.setLedgerMcpStartupMode(mode))
}

export function fetchLedgerMcpConnection(): Promise<ApiResult<LedgerMcpConnection>> {
  return fetchPayload('ledger MCP connection', ledgerMcpConnectionSchema, () => window.api.getLedgerMcpConnection())
}

export function fetchRegenerateLedgerMcpToken(): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP token', ledgerMcpStatusSchema, () => window.api.regenerateLedgerMcpToken())
}

export function fetchRefreshPricing(): Promise<ApiResult<PricingRefreshResult>> {
  return fetchPayload('pricing refresh', pricingRefreshResultSchema, () => window.api.refreshPricing())
}

export function fetchCheckForUpdates(): Promise<ApiResult<UpdateStatus>> {
  return fetchPayload('update status', updateStatusSchema, () => window.api.checkForUpdates())
}

export function fetchCurrency(): Promise<ApiResult<ActiveCurrency>> {
  return fetchPayload('currency', activeCurrencySchema, () => window.api.getCurrency())
}

export function fetchSetCurrency(code: string): Promise<ApiResult<ActiveCurrency>> {
  return fetchPayload('currency', activeCurrencySchema, () => window.api.setCurrency(code))
}

export function fetchCurrencies(): Promise<ApiResult<CurrencyOption[]>> {
  return fetchPayload('currency options', z.array(currencyOptionSchema), () => window.api.getCurrencies())
}

export function fetchCadence(): Promise<ApiResult<CadenceValue>> {
  return fetchPayload('cadence', cadenceValueSchema, () => window.api.getCadence())
}

export function fetchSetCadence(value: string): Promise<ApiResult<CadenceValue>> {
  return fetchPayload('cadence', cadenceValueSchema, () => window.api.setCadence(value))
}

export function fetchAppVersion(): Promise<ApiResult<AppVersion>> {
  return fetchPayload('app version', appVersionSchema, () => window.api.getAppVersion())
}

export function fetchSearch(query: string): Promise<ApiResult<SearchHit[]>> {
  return fetchPayload('search', z.array(searchHitSchema), () => window.api.search(query))
}

export function fetchExport(format: 'csv' | 'json', destination?: string): Promise<ApiResult<ExportResult>> {
  return fetchPayload('export', exportResultSchema, () => window.api.exportData(format, destination))
}

export function fetchScan(options?: { provider?: string }): Promise<ApiResult<ScanResult>> {
  return fetchPayload('scan', scanResultSchema, () => window.api.scan(options))
}

export function fetchAddModelAlias(model: string, aliasOf: string): Promise<ApiResult<OkEnvelope>> {
  return fetchPayload('model alias write', okEnvelopeSchema, () => window.api.addModelAlias(model, aliasOf))
}

export function fetchRemoveModelAlias(model: string): Promise<ApiResult<OkEnvelope>> {
  return fetchPayload('model alias remove', okEnvelopeSchema, () => window.api.removeModelAlias(model))
}

export function fetchSetModelPrice(
  model: string,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
): Promise<ApiResult<OkEnvelope>> {
  return fetchPayload('price write', okEnvelopeSchema, () =>
    window.api.setModelPrice(model, inputPricePerMillion, outputPricePerMillion),
  )
}

export function fetchRemovePriceOverride(model: string): Promise<ApiResult<OkEnvelope>> {
  return fetchPayload('price remove', okEnvelopeSchema, () => window.api.removePriceOverride(model))
}

export function fetchCoachHarnesses(): Promise<ApiResult<CoachHarnessesResult>> {
  return fetchPayload('coach harnesses', coachHarnessesResultSchema, () => window.api.getCoachHarnesses())
}

/** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
 *  models/modes without a run, so the pickers render before the first
 *  message. A failed probe is `{ ok: false }` — the pickers stay absent. The
 *  request carries the API-key passthrough flag so the probe spawns the agent
 *  exactly like the run that may resume its warmed session. */
export function fetchCoachInspect(request: CoachInspectRequest): Promise<ApiResult<CoachInspectResult>> {
  return fetchPayload('coach inspect', coachInspectResultSchema, () => window.api.inspectCoachHarness(request))
}

export function fetchCoachRun(request: CoachRunRequest): Promise<ApiResult<CoachRunResult>> {
  return fetchPayload('coach run', coachRunResultSchema, () => window.api.startCoachRun(request))
}
