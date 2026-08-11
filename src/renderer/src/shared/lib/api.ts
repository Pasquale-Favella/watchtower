/**
 * Renderer fetch library (ADR 0005) — the renderer-side tripwire over
 * the preload's IPC surface. Every payload-bearing channel is `safeParse`d
 * against the same shared schema the main process validates against, so a
 * malformed payload becomes a `{ ok: false }` result the views render as an
 * error state instead of a crash or garbage. The wire contract is frozen: no
 * channel name, request shape, or payload byte changes here.
 */
import { z } from 'zod'

import { overviewPayloadSchema, type OverviewPayload, type OverviewScope } from '../../../../shared/schemas/overview.js'
import {
  analyticalViewsSchema,
  dashboardViewsSchema,
  projectRowSchema,
  searchHitSchema,
  sessionDetailSchema,
  sessionRowSchema,
  type AnalyticalViews,
  type DashboardViews,
  type ProjectRow,
  type SearchHit,
  type SessionDetail,
  type SessionRow,
} from '../../../../shared/schemas/views.js'
import { spendPayloadSchema, type SpendPayload } from '../../../../shared/schemas/spend.js'
import {
  modelAliasSchema,
  modelsPayloadSchema,
  priceOverrideSchema,
  type ModelAlias,
  type ModelsPayload,
  type PriceOverride,
} from '../../../../shared/schemas/models.js'
import {
  comparePayloadSchema,
  type ComparePair,
  type ComparePayload,
} from '../../../../shared/schemas/compare.js'
import { optimizePayloadSchema, type OptimizePayload } from '../../../../shared/schemas/optimize.js'
import { yieldPayloadSchema, type YieldPayload } from '../../../../shared/schemas/yield.js'
import { skillsPayloadSchema, type SkillsPayload, type SkillsThresholds } from '../../../../shared/schemas/skills.js'
import {
  pullRequestsPayloadSchema,
  type PullRequestsPayload,
} from '../../../../shared/schemas/pull-requests.js'
import {
  pricingRefreshResultSchema,
  scanResultSchema,
  scanStatusSchema,
  settingsInfoSchema,
  type PricingRefreshResult,
  type ScanResult,
  type ScanStatus,
  type SettingsInfo,
} from '../../../../shared/schemas/ipc.js'
import { updateStatusSchema, appVersionSchema, type AppVersion, type UpdateStatus } from '../../../../shared/schemas/updates.js'
import {
  activeCurrencySchema,
  currencyOptionSchema,
  type ActiveCurrency,
  type CurrencyOption,
} from '../../../../shared/schemas/fx.js'
import { cadenceValueSchema, type CadenceValue } from '../../../../shared/schemas/cadence.js'
import { exportResultSchema, type ExportResult } from '../../../../shared/schemas/export.js'
import {
  agentsConsentResultSchema,
  coachHarnessesResultSchema,
  coachRunResultSchema,
  type AgentsConsentResult,
  type CoachHarnessesResult,
  type CoachRunRequest,
  type CoachRunResult,
} from '../../../../shared/schemas/agents.js'

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
 * payloads too. A malformed broadcast is dropped and logged, never applied to
 * renderer state — a bad `scan:progress` or `currency:changed` can't paint
 * garbage, it just falls back to the last good value. */
export function parseEvent<T>(schema: z.ZodType<T>, label: string, raw: unknown): T | null {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length ? issue.path.join('.') : 'payload'
  const detail = issue ? issue.message : 'does not match the expected shape'
  console.error(`Invalid ${label} event (${where}: ${detail})`)
  return null
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

export function fetchSessions(filter?: { project?: string; since?: string; until?: string }): Promise<ApiResult<SessionRow[]>> {
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

export function fetchSessionRows(scope: OverviewScope): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('session rows', z.array(sessionRowSchema), () => window.api.getSessionRows(scope))
}

export function fetchPullRequests(scope: OverviewScope): Promise<ApiResult<PullRequestsPayload | null>> {
  return fetchPayload('pull requests', pullRequestsPayloadSchema.nullable(), () => window.api.getPullRequests(scope))
}

export function fetchSpend(scope: OverviewScope): Promise<ApiResult<SpendPayload | null>> {
  return fetchPayload('spend', spendPayloadSchema.nullable(), () => window.api.getSpend(scope))
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
  return fetchPayload('price write', okEnvelopeSchema, () => window.api.setModelPrice(model, inputPricePerMillion, outputPricePerMillion))
}

export function fetchRemovePriceOverride(model: string): Promise<ApiResult<OkEnvelope>> {
  return fetchPayload('price remove', okEnvelopeSchema, () => window.api.removePriceOverride(model))
}

export function fetchCoachHarnesses(): Promise<ApiResult<CoachHarnessesResult>> {
  return fetchPayload('coach harnesses', coachHarnessesResultSchema, () => window.api.getCoachHarnesses())
}

export function fetchCoachRun(request: CoachRunRequest): Promise<ApiResult<CoachRunResult>> {
  return fetchPayload('coach run', coachRunResultSchema, () => window.api.startCoachRun(request))
}

export function fetchAgentsConsent(): Promise<ApiResult<AgentsConsentResult>> {
  return fetchPayload('agents consent', agentsConsentResultSchema, () => window.api.getAgentsConsent())
}

export function fetchSetAgentsConsent(granted: boolean): Promise<ApiResult<AgentsConsentResult>> {
  return fetchPayload('agents consent', agentsConsentResultSchema, () => window.api.setAgentsConsent(granted))
}
