/**
 * Renderer fetch library (ADR 0005) — the renderer-side tripwire over
 * the preload's IPC surface. Every payload-bearing channel is decoded
 * against the same shared schema the main process validates against, so a
 * malformed payload becomes a `{ ok: false }` result the views render as an
 * error state instead of a crash or garbage. The wire contract is frozen: no
 * channel name, request shape, or payload byte changes here.
 */
import * as Schema from 'effect/Schema'
import { z } from 'zod'

import {
  type CoachHarnessesResult,
  coachHarnessesResultSchema,
  type CoachHarnessRow,
  type CoachInspectRequest,
  type CoachInspectResult,
  coachInspectResultSchema,
  type CoachLoginTerminalResult,
  coachLoginTerminalResultSchema,
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
  currencyOptionsSchema,
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
  type SessionRow,
  sessionRowSchema,
} from '../../../../shared/schemas/views.js'
import { type YieldPayload, yieldPayloadSchema } from '../../../../shared/schemas/yield.js'
import { type Decoder, effectSchemaDecoder, zodDecoder } from './schema-decoder.js'

/** The shared renderer error shape for an IPC payload: either validated data
 * or a human-readable message naming the channel and the failing field. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Decodes a raw IPC payload against its shared contract. Invalid payloads
 * become a visible error naming the channel and first failing field/path —
 * never garbage the views would render. */
export function parsePayload<T>(decoder: Decoder<T>, label: string, raw: unknown): ApiResult<T> {
  const parsed = decodeSafely(decoder, raw)
  if (parsed.ok) return { ok: true, data: parsed.value }
  return { ok: false, error: `Invalid ${label} payload (${parsed.path}: ${parsed.message})` }
}

/** Runs an IPC invoke and decodes its resolution; a rejected IPC call also
 * surfaces as a `{ ok: false }` result (never an unhandled rejection). */
export async function fetchPayload<T>(
  label: string,
  decoder: Decoder<T>,
  invoke: () => Promise<unknown>,
): Promise<ApiResult<T>> {
  try {
    return parsePayload(decoder, label, await invoke())
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Temporary adapter for contracts still authored in Zod. Remove it after the
 * last Zod-backed renderer fetch contract migrates to Effect Schema.
 */
export function fetchZodPayload<T>(
  label: string,
  schema: z.ZodType<T>,
  invoke: () => Promise<unknown>,
): Promise<ApiResult<T>> {
  return fetchPayload(label, zodDecoder(schema), invoke)
}

/** The subscription-event tripwire (ADR 0005): broadcast channels carry
 * payloads too. A malformed broadcast is dropped and forwarded to the
 * Operational log with its label + location only (never contents) — a bad
 * `scan:progress` or `currency:changed` can't paint garbage, it just falls
 * back to the last good value. The forward never breaks rendering. */
export function parseEvent<T>(decoder: Decoder<T>, label: string, raw: unknown): T | null {
  const parsed = decodeSafely(decoder, raw)
  if (parsed.ok) return parsed.value
  forwardTripwireNotice(label, parsed.path)
  return null
}

function decodeSafely<T>(decoder: Decoder<T>, raw: unknown): ReturnType<Decoder<T>> {
  try {
    return decoder(raw)
  } catch {
    return { ok: false, path: 'payload', message: 'could not be validated' }
  }
}

/**
 * Temporary adapter for events still authored in Zod. Remove it after the
 * last Zod-backed renderer event contract migrates to Effect Schema.
 */
export function parseZodEvent<T>(schema: z.ZodType<T>, label: string, raw: unknown): T | null {
  return parseEvent(zodDecoder(schema), label, raw)
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
  return fetchPayload('scan status', effectSchemaDecoder(scanStatusSchema), () => window.api.getScanStatus())
}

export function fetchViews(): Promise<ApiResult<DashboardViews | null>> {
  return fetchPayload('dashboard views', effectSchemaDecoder(Schema.NullOr(dashboardViewsSchema)), () =>
    window.api.getViews(),
  )
}

export function fetchProjects(): Promise<ApiResult<ProjectRow[]>> {
  return fetchPayload('projects', effectSchemaDecoder(Schema.mutable(Schema.Array(projectRowSchema))), () =>
    window.api.getProjects(),
  )
}

export function fetchSessions(filter?: {
  project?: string
  since?: string
  until?: string
}): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('sessions', effectSchemaDecoder(Schema.mutable(Schema.Array(sessionRowSchema))), () =>
    window.api.getSessions(filter),
  )
}

export function fetchSession(sessionId: string): Promise<ApiResult<SessionDetail | null>> {
  return fetchPayload('session detail', effectSchemaDecoder(Schema.NullOr(sessionDetailSchema)), () =>
    window.api.getSession(sessionId),
  )
}

export function fetchAnalytics(): Promise<ApiResult<AnalyticalViews | null>> {
  return fetchPayload('analytics', effectSchemaDecoder(Schema.NullOr(analyticalViewsSchema)), () =>
    window.api.getAnalytics(),
  )
}

export function fetchOverview(scope: OverviewScope): Promise<ApiResult<OverviewPayload | null>> {
  return fetchZodPayload('overview', overviewPayloadSchema.nullable(), () => window.api.getOverview(scope))
}

export function fetchSessionRows(scope: OverviewScope): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('session rows', effectSchemaDecoder(Schema.mutable(Schema.Array(sessionRowSchema))), () =>
    window.api.getSessionRows(scope),
  )
}

export function fetchPullRequests(scope: OverviewScope): Promise<ApiResult<PullRequestsPayload | null>> {
  return fetchPayload('pull requests', effectSchemaDecoder(Schema.NullOr(pullRequestsPayloadSchema)), () =>
    window.api.getPullRequests(scope),
  )
}

export function fetchSpend(scope: OverviewScope): Promise<ApiResult<SpendPayload | null>> {
  return fetchPayload('spend', effectSchemaDecoder(Schema.NullOr(spendPayloadSchema)), () => window.api.getSpend(scope))
}

export function fetchModels(scope: OverviewScope): Promise<ApiResult<ModelsPayload | null>> {
  return fetchPayload('models', effectSchemaDecoder(Schema.NullOr(modelsPayloadSchema)), () =>
    window.api.getModels(scope),
  )
}

export function fetchCompare(scope: OverviewScope, pair?: ComparePair): Promise<ApiResult<ComparePayload | null>> {
  return fetchPayload('compare', effectSchemaDecoder(Schema.NullOr(comparePayloadSchema)), () =>
    window.api.getCompare(scope, pair),
  )
}

export function fetchOptimize(scope: OverviewScope): Promise<ApiResult<OptimizePayload | null>> {
  return fetchPayload('optimize', effectSchemaDecoder(Schema.NullOr(optimizePayloadSchema)), () =>
    window.api.getOptimize(scope),
  )
}

export function fetchYield(scope: OverviewScope): Promise<ApiResult<YieldPayload | null>> {
  return fetchPayload('yield', effectSchemaDecoder(Schema.NullOr(yieldPayloadSchema)), () => window.api.getYield(scope))
}

export function fetchSkills(
  scope: OverviewScope,
  thresholds?: SkillsThresholds,
): Promise<ApiResult<SkillsPayload | null>> {
  return fetchPayload('skills', effectSchemaDecoder(Schema.NullOr(skillsPayloadSchema)), () =>
    window.api.getSkills(scope, thresholds),
  )
}

export function fetchDismissSkill(request: SkillsDismissalRequest): Promise<ApiResult<SkillsDismissalResult>> {
  return fetchPayload('skills dismissal', effectSchemaDecoder(skillsDismissalResultSchema), () =>
    window.api.dismissSkill(request),
  )
}

export function fetchSaveSkill(request: SkillsSaveRequest): Promise<ApiResult<SkillsSaveResult>> {
  return fetchPayload('skills save', effectSchemaDecoder(skillsSaveResultSchema), () => window.api.saveSkill(request))
}

export function fetchModelAliases(): Promise<ApiResult<ModelAlias[]>> {
  return fetchPayload('model aliases', effectSchemaDecoder(Schema.mutable(Schema.Array(modelAliasSchema))), () =>
    window.api.getModelAliases(),
  )
}

export function fetchPriceOverrides(): Promise<ApiResult<PriceOverride[]>> {
  return fetchPayload('price overrides', effectSchemaDecoder(Schema.mutable(Schema.Array(priceOverrideSchema))), () =>
    window.api.getPriceOverrides(),
  )
}

export function fetchSettings(): Promise<ApiResult<SettingsInfo>> {
  return fetchPayload('settings', effectSchemaDecoder(settingsInfoSchema), () => window.api.getSettings())
}

export function fetchClearData(): Promise<ApiResult<SettingsInfo>> {
  return fetchPayload('cleared settings', effectSchemaDecoder(settingsInfoSchema), () => window.api.clearData())
}

export function fetchLedgerMcpStatus(): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP status', effectSchemaDecoder(ledgerMcpStatusSchema), () =>
    window.api.getLedgerMcpStatus(),
  )
}

export function fetchSetLedgerMcpStartupMode(mode: LedgerMcpStartupMode): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP startup mode', effectSchemaDecoder(ledgerMcpStatusSchema), () =>
    window.api.setLedgerMcpStartupMode(mode),
  )
}

export function fetchLedgerMcpConnection(): Promise<ApiResult<LedgerMcpConnection>> {
  return fetchPayload('ledger MCP connection', effectSchemaDecoder(ledgerMcpConnectionSchema), () =>
    window.api.getLedgerMcpConnection(),
  )
}

export function fetchRegenerateLedgerMcpToken(): Promise<ApiResult<LedgerMcpStatus>> {
  return fetchPayload('ledger MCP token', effectSchemaDecoder(ledgerMcpStatusSchema), () =>
    window.api.regenerateLedgerMcpToken(),
  )
}

export function fetchRefreshPricing(): Promise<ApiResult<PricingRefreshResult>> {
  return fetchPayload('pricing refresh', effectSchemaDecoder(pricingRefreshResultSchema), () =>
    window.api.refreshPricing(),
  )
}

export function fetchCheckForUpdates(): Promise<ApiResult<UpdateStatus>> {
  return fetchPayload('update status', effectSchemaDecoder(updateStatusSchema), () => window.api.checkForUpdates())
}

export function fetchCurrency(): Promise<ApiResult<ActiveCurrency>> {
  return fetchPayload('currency', effectSchemaDecoder(activeCurrencySchema), () => window.api.getCurrency())
}

export function fetchSetCurrency(code: string): Promise<ApiResult<ActiveCurrency>> {
  return fetchPayload('currency', effectSchemaDecoder(activeCurrencySchema), () => window.api.setCurrency(code))
}

export function fetchCurrencies(): Promise<ApiResult<CurrencyOption[]>> {
  return fetchPayload('currency options', effectSchemaDecoder(currencyOptionsSchema), () => window.api.getCurrencies())
}

export function fetchCadence(): Promise<ApiResult<CadenceValue>> {
  return fetchPayload('cadence', effectSchemaDecoder(cadenceValueSchema), () => window.api.getCadence())
}

export function fetchSetCadence(value: string): Promise<ApiResult<CadenceValue>> {
  return fetchPayload('cadence', effectSchemaDecoder(cadenceValueSchema), () => window.api.setCadence(value))
}

export function fetchAppVersion(): Promise<ApiResult<AppVersion>> {
  return fetchPayload('app version', effectSchemaDecoder(appVersionSchema), () => window.api.getAppVersion())
}

export function fetchSearch(query: string): Promise<ApiResult<SearchHit[]>> {
  return fetchPayload('search', effectSchemaDecoder(Schema.mutable(Schema.Array(searchHitSchema))), () =>
    window.api.search(query),
  )
}

export function fetchExport(format: 'csv' | 'json', destination?: string): Promise<ApiResult<ExportResult>> {
  return fetchPayload('export', effectSchemaDecoder(exportResultSchema), () =>
    window.api.exportData(format, destination),
  )
}

export function fetchScan(options?: { provider?: string }): Promise<ApiResult<ScanResult>> {
  return fetchPayload('scan', effectSchemaDecoder(scanResultSchema), () => window.api.scan(options))
}

export function fetchAddModelAlias(model: string, aliasOf: string): Promise<ApiResult<OkEnvelope>> {
  return fetchZodPayload('model alias write', okEnvelopeSchema, () => window.api.addModelAlias(model, aliasOf))
}

export function fetchRemoveModelAlias(model: string): Promise<ApiResult<OkEnvelope>> {
  return fetchZodPayload('model alias remove', okEnvelopeSchema, () => window.api.removeModelAlias(model))
}

export function fetchSetModelPrice(
  model: string,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
): Promise<ApiResult<OkEnvelope>> {
  return fetchZodPayload('price write', okEnvelopeSchema, () =>
    window.api.setModelPrice(model, inputPricePerMillion, outputPricePerMillion),
  )
}

export function fetchRemovePriceOverride(model: string): Promise<ApiResult<OkEnvelope>> {
  return fetchZodPayload('price remove', okEnvelopeSchema, () => window.api.removePriceOverride(model))
}

export function fetchCoachHarnesses(): Promise<ApiResult<CoachHarnessesResult>> {
  return fetchZodPayload('coach harnesses', coachHarnessesResultSchema, () => window.api.getCoachHarnesses())
}

export function refreshCoachHarnesses(): Promise<ApiResult<CoachHarnessesResult>> {
  return fetchZodPayload('coach harnesses refresh', coachHarnessesResultSchema, () =>
    window.api.refreshCoachHarnesses(),
  )
}

export function openCoachLoginTerminal(instanceId: string): Promise<ApiResult<CoachLoginTerminalResult>> {
  return fetchZodPayload('coach login terminal', coachLoginTerminalResultSchema, () =>
    window.api.openCoachLoginTerminal(instanceId),
  )
}

export function onCoachHarnessesChanged(callback: (rows: CoachHarnessRow[]) => void): () => void {
  return window.api.onCoachHarnessesChanged(rows => {
    const parsed = parseZodEvent(coachHarnessesResultSchema, 'coach harnesses changed', rows)
    if (parsed) callback(parsed)
  })
}

/** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
 *  models/modes without a run, so the pickers render before the first
 *  message. A failed probe is `{ ok: false }` — the pickers stay absent. The
 *  request carries the API-key passthrough flag so the probe spawns the agent
 *  exactly like a run would (probes never warm a resumable session). */
export function fetchCoachInspect(request: CoachInspectRequest): Promise<ApiResult<CoachInspectResult>> {
  return fetchZodPayload('coach inspect', coachInspectResultSchema, () => window.api.inspectCoachHarness(request))
}

export function fetchCoachRun(request: CoachRunRequest): Promise<ApiResult<CoachRunResult>> {
  return fetchZodPayload('coach run', coachRunResultSchema, () => window.api.startCoachRun(request))
}
