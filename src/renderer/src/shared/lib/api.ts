/**
 * Renderer fetch library (ADR 0005) — the renderer-side tripwire over
 * the preload's IPC surface. Every payload-bearing channel is decoded
 * against the same shared schema the main process validates against, so a
 * malformed payload becomes a `{ ok: false }` result the views render as an
 * error state instead of a crash or garbage. The wire contract is frozen: no
 * channel name, request shape, or payload byte changes here.
 */
import * as Schema from 'effect/Schema'

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
import { type Section, sectionSchema } from '../../../../shared/schemas/navigation.js'
import { type OptimizePayload, optimizePayloadSchema } from '../../../../shared/schemas/optimize.js'
import { type OrbPanelRequest, type OrbPlacement, orbPlacementSchema } from '../../../../shared/schemas/orb.js'
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
import { decodeSchema } from './schema-decoder.js'

/** The shared renderer error shape for an IPC payload: either validated data
 * or a human-readable message naming the channel and the failing field. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Decodes a raw IPC payload against its shared contract. Invalid payloads
 * become a visible error naming the channel and first failing field/path —
 * never garbage the views would render. */
export function parsePayload<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  label: string,
  raw: unknown,
): ApiResult<S['Type']> {
  const parsed = decodeSchema(schema, raw)
  if (parsed.ok) return { ok: true, data: parsed.value }
  return { ok: false, error: `Invalid ${label} payload (${parsed.path}: ${parsed.message})` }
}

/** Runs an IPC invoke and decodes its resolution; a rejected IPC call also
 * surfaces as a `{ ok: false }` result (never an unhandled rejection). */
export async function fetchPayload<S extends Schema.ConstraintDecoder<unknown>>(
  label: string,
  schema: S,
  invoke: () => Promise<unknown>,
): Promise<ApiResult<S['Type']>> {
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
export function parseEvent<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  label: string,
  raw: unknown,
): S['Type'] | null {
  const parsed = decodeSchema(schema, raw)
  if (parsed.ok) return parsed.value
  forwardTripwireNotice(label, parsed.path)
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

const okEnvelopeSchema = Schema.Struct({ ok: Schema.mutableKey(Schema.Literal(true)) })
export type OkEnvelope = Schema.Schema.Type<typeof okEnvelopeSchema>

export function fetchScanStatus(): Promise<ApiResult<ScanStatus>> {
  return fetchPayload('scan status', scanStatusSchema, () => window.api.getScanStatus())
}

export function fetchScanActive(): Promise<ApiResult<boolean>> {
  return fetchPayload('scan active', Schema.Boolean, () => window.api.getScanActive())
}

export function fetchViews(): Promise<ApiResult<DashboardViews | null>> {
  return fetchPayload('dashboard views', Schema.NullOr(dashboardViewsSchema), () => window.api.getViews())
}

export function fetchProjects(): Promise<ApiResult<ProjectRow[]>> {
  return fetchPayload('projects', Schema.mutable(Schema.Array(projectRowSchema)), () => window.api.getProjects())
}

export function fetchSessions(filter?: {
  project?: string
  since?: string
  until?: string
}): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('sessions', Schema.mutable(Schema.Array(sessionRowSchema)), () => window.api.getSessions(filter))
}

export function fetchSession(sessionId: string): Promise<ApiResult<SessionDetail | null>> {
  return fetchPayload('session detail', Schema.NullOr(sessionDetailSchema), () => window.api.getSession(sessionId))
}

export function fetchAnalytics(): Promise<ApiResult<AnalyticalViews | null>> {
  return fetchPayload('analytics', Schema.NullOr(analyticalViewsSchema), () => window.api.getAnalytics())
}

export function fetchOverview(scope: OverviewScope): Promise<ApiResult<OverviewPayload | null>> {
  return fetchPayload('overview', Schema.NullOr(overviewPayloadSchema), () => window.api.getOverview(scope))
}

export function fetchSessionRows(scope: OverviewScope): Promise<ApiResult<SessionRow[]>> {
  return fetchPayload('session rows', Schema.mutable(Schema.Array(sessionRowSchema)), () =>
    window.api.getSessionRows(scope),
  )
}

export function fetchPullRequests(scope: OverviewScope): Promise<ApiResult<PullRequestsPayload | null>> {
  return fetchPayload('pull requests', Schema.NullOr(pullRequestsPayloadSchema), () =>
    window.api.getPullRequests(scope),
  )
}

export function fetchSpend(scope: OverviewScope): Promise<ApiResult<SpendPayload | null>> {
  return fetchPayload('spend', Schema.NullOr(spendPayloadSchema), () => window.api.getSpend(scope))
}

export function fetchModels(scope: OverviewScope): Promise<ApiResult<ModelsPayload | null>> {
  return fetchPayload('models', Schema.NullOr(modelsPayloadSchema), () => window.api.getModels(scope))
}

export function fetchCompare(scope: OverviewScope, pair?: ComparePair): Promise<ApiResult<ComparePayload | null>> {
  return fetchPayload('compare', Schema.NullOr(comparePayloadSchema), () => window.api.getCompare(scope, pair))
}

export function fetchOptimize(scope: OverviewScope): Promise<ApiResult<OptimizePayload | null>> {
  return fetchPayload('optimize', Schema.NullOr(optimizePayloadSchema), () => window.api.getOptimize(scope))
}

export function fetchYield(scope: OverviewScope): Promise<ApiResult<YieldPayload | null>> {
  return fetchPayload('yield', Schema.NullOr(yieldPayloadSchema), () => window.api.getYield(scope))
}

export function fetchSkills(
  scope: OverviewScope,
  thresholds?: SkillsThresholds,
): Promise<ApiResult<SkillsPayload | null>> {
  return fetchPayload('skills', Schema.NullOr(skillsPayloadSchema), () => window.api.getSkills(scope, thresholds))
}

export function fetchDismissSkill(request: SkillsDismissalRequest): Promise<ApiResult<SkillsDismissalResult>> {
  return fetchPayload('skills dismissal', skillsDismissalResultSchema, () => window.api.dismissSkill(request))
}

export function fetchSaveSkill(request: SkillsSaveRequest): Promise<ApiResult<SkillsSaveResult>> {
  return fetchPayload('skills save', skillsSaveResultSchema, () => window.api.saveSkill(request))
}

export function fetchModelAliases(): Promise<ApiResult<ModelAlias[]>> {
  return fetchPayload('model aliases', Schema.mutable(Schema.Array(modelAliasSchema)), () =>
    window.api.getModelAliases(),
  )
}

export function fetchPriceOverrides(): Promise<ApiResult<PriceOverride[]>> {
  return fetchPayload('price overrides', Schema.mutable(Schema.Array(priceOverrideSchema)), () =>
    window.api.getPriceOverrides(),
  )
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
  return fetchPayload('currency options', currencyOptionsSchema, () => window.api.getCurrencies())
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
  return fetchPayload('search', Schema.mutable(Schema.Array(searchHitSchema)), () => window.api.search(query))
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

export function refreshCoachHarnesses(): Promise<ApiResult<CoachHarnessesResult>> {
  return fetchPayload('coach harnesses refresh', coachHarnessesResultSchema, () => window.api.refreshCoachHarnesses())
}

export function openCoachLoginTerminal(instanceId: string): Promise<ApiResult<CoachLoginTerminalResult>> {
  return fetchPayload('coach login terminal', coachLoginTerminalResultSchema, () =>
    window.api.openCoachLoginTerminal(instanceId),
  )
}

export function onCoachHarnessesChanged(callback: (rows: CoachHarnessRow[]) => void): () => void {
  return window.api.onCoachHarnessesChanged(rows => {
    const parsed = parseEvent(coachHarnessesResultSchema, 'coach harnesses changed', rows)
    if (parsed) callback(parsed)
  })
}

/** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
 *  models/modes without a run, so the pickers render before the first
 *  message. A failed probe is `{ ok: false }` — the pickers stay absent. The
 *  request carries the API-key passthrough flag so the probe spawns the agent
 *  exactly like a run would (probes never warm a resumable session). */
export function fetchCoachInspect(request: CoachInspectRequest): Promise<ApiResult<CoachInspectResult>> {
  return fetchPayload('coach inspect', coachInspectResultSchema, () => window.api.inspectCoachHarness(request))
}

export function fetchCoachRun(request: CoachRunRequest): Promise<ApiResult<CoachRunResult>> {
  return fetchPayload('coach run', coachRunResultSchema, () => window.api.startCoachRun(request))
}

/** Background orb (main/background-shell.ts): the orb pages' window controls.
 * Placement is decoded like any other payload (ADR 0005); the
 * fire-and-forget controls carry no payload back. */
const nullableOrbPlacementSchema = Schema.NullOr(orbPlacementSchema)

export function fetchOrbPlacement(): Promise<ApiResult<OrbPlacement | null>> {
  return fetchPayload('orb placement', nullableOrbPlacementSchema, () => window.api.orb.getPlacement())
}

/** `open` (the user's own request, focused) or `fold`. Resolves with the
 * placement the main process applied. */
export function fetchOrbPanelRequest(request: OrbPanelRequest): Promise<ApiResult<OrbPlacement | null>> {
  return fetchPayload('orb placement', nullableOrbPlacementSchema, () => window.api.orb.requestPanel(request))
}

export const orbControls = {
  dragStart: (): void => window.api.orb.dragStart(),
  dragMove: (dx: number, dy: number): void => window.api.orb.dragMove(dx, dy),
  dragEnd: (): void => window.api.orb.dragEnd(),
  openApp: (section?: Section): void => window.api.orb.openApp(section),
  hide: (): void => window.api.orb.hide(),
  quit: (): void => window.api.orb.quit(),
  panelPainted: (): void => window.api.orb.panelPainted(),
  panelDataReady: (): void => window.api.orb.panelDataReady(),
}

export function onOrbPlacement(callback: (placement: OrbPlacement) => void): () => void {
  return window.api.orb.onPlacement(raw => {
    const parsed = parseEvent(orbPlacementSchema, 'orb placement', raw)
    if (parsed) callback(parsed)
  })
}

/** Main window: the orb asked to open the app on a section. */
export function onAppNavigate(callback: (section: Section) => void): () => void {
  return window.api.onNavigate(raw => {
    const parsed = parseEvent(sectionSchema, 'app navigate', raw)
    if (parsed) callback(parsed)
  })
}
