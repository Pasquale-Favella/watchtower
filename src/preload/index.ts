import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ScanMetadata } from '../shared/schemas/scan.js'
import type { DashboardViews, SessionDetail, SessionRow, ProjectRow, AnalyticalViews, SearchHit } from '../main/views.js'
import type { OverviewPayload, OverviewScope } from '../main/overview.js'
import type { PullRequestsPayload } from '../main/pull-requests-view.js'
import type { SpendPayload } from '../main/spend-view.js'
import type { ModelsPayload } from '../main/models-view.js'
import type { ComparePair, ComparePayload } from '../main/compare-view.js'
import type { OptimizePayload } from '../main/optimize-view.js'
import type { YieldPayload } from '../main/yield-view.js'
import type {
  SkillsDismissalRequest,
  SkillsDismissalResult,
  SkillsPayload,
  SkillsProseRequest,
  SkillsProseResult,
  SkillsSaveRequest,
  SkillsSaveResult,
  SkillsThresholds,
} from '../shared/schemas/skills.js'
import type { UpdateStatus } from '../main/updates.js'
import type { ActiveCurrency, CurrencyOption } from '../main/fx.js'
import type { ExportResult } from '../main/export.js'
import type {
  PricingRefreshResult,
  ScanProgressMessage,
  ScanResult,
  ScanStatus,
  SettingsInfo,
  StoreChangedMessage,
} from '../shared/schemas/ipc.js'
import type {
  AgentsConsentResult,
  CoachEventEnvelope,
  CoachHarnessesResult,
  CoachRunRequest,
  CoachRunResult,
} from '../shared/schemas/agents.js'

export type {
  PricingRefreshResult,
  ScanProgressMessage,
  ScanResult,
  ScanStatus,
  SettingsInfo,
  StoreChangedMessage,
} from '../shared/schemas/ipc.js'
export type {
  AgentsConsentResult,
  CoachEventEnvelope,
  CoachHarnessesResult,
  CoachRunRequest,
  CoachRunResult,
} from '../shared/schemas/agents.js'

const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  platform: process.platform,
  scan: (options?: { provider?: string }): Promise<ScanResult> =>
    ipcRenderer.invoke('scan:start', options),
  abort: (): void => ipcRenderer.send('scan:abort'),
  onProgress: (callback: (progress: ScanProgressMessage) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: ScanProgressMessage): void => callback(progress)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },
  onError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on('scan:error', listener)
    return () => ipcRenderer.removeListener('scan:error', listener)
  },
  onChanged: (callback: (message: StoreChangedMessage) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: StoreChangedMessage): void => callback(message)
    ipcRenderer.on('store:changed', listener)
    return () => ipcRenderer.removeListener('store:changed', listener)
  },
  onIdle: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('scan:idle', listener)
    return () => ipcRenderer.removeListener('scan:idle', listener)
  },
  getCadence: (): Promise<string> => ipcRenderer.invoke('cadence:get'),
  setCadence: (value: string): Promise<string> => ipcRenderer.invoke('cadence:set', value),
  /** Scan status (ADR 0004): latest completed scan's metadata or the
   * "never scanned" sentinel; the replacement for the old `getReport()` boot
   * read. */
  getScanStatus: (): Promise<ScanStatus> => ipcRenderer.invoke('store:status'),
  /** Fired when a config write (price override / model alias) lands, so the
   * mounted view refetches with the fresh query-time config (ADR 0004).
   * Distinct from `store:changed` — no rebuild, no rescan. */
  onConfigChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('config:changed', listener)
    return () => ipcRenderer.removeListener('config:changed', listener)
  },
  getViews: (): Promise<DashboardViews | null> => ipcRenderer.invoke('store:views'),
  getProjects: (): Promise<ProjectRow[]> => ipcRenderer.invoke('store:projects'),
  getSessions: (filter?: { project?: string; since?: string; until?: string }): Promise<SessionRow[]> =>
    ipcRenderer.invoke('store:sessions', filter),
  getSession: (sessionId: string): Promise<SessionDetail | null> => ipcRenderer.invoke('store:session', sessionId),
  getAnalytics: (): Promise<AnalyticalViews | null> => ipcRenderer.invoke('store:analytics'),
  getOverview: (scope: OverviewScope): Promise<OverviewPayload | null> => ipcRenderer.invoke('overview:query', scope),
  getSessionRows: (scope: OverviewScope): Promise<SessionRow[]> => ipcRenderer.invoke('sessions:view', scope),
  getPullRequests: (scope: OverviewScope): Promise<PullRequestsPayload | null> => ipcRenderer.invoke('pullRequests:view', scope),
  getSpend: (scope: OverviewScope): Promise<SpendPayload | null> => ipcRenderer.invoke('spend:view', scope),
  getModels: (scope: OverviewScope): Promise<ModelsPayload | null> => ipcRenderer.invoke('models:view', scope),
  getCompare: (scope: OverviewScope, pair?: ComparePair): Promise<ComparePayload | null> =>
    ipcRenderer.invoke('compare:view', scope, pair),
  getOptimize: (scope: OverviewScope): Promise<OptimizePayload | null> =>
    ipcRenderer.invoke('optimize:view', scope),
  getYield: (scope: OverviewScope): Promise<YieldPayload | null> =>
    ipcRenderer.invoke('optimize:yield', scope),
  getSkills: (scope: OverviewScope, thresholds?: SkillsThresholds): Promise<SkillsPayload | null> =>
    ipcRenderer.invoke('skills:view', scope, thresholds),
  dismissSkill: (request: SkillsDismissalRequest): Promise<SkillsDismissalResult> =>
    ipcRenderer.invoke('skills:dismiss', request),
  getDraftProse: (request: SkillsProseRequest): Promise<SkillsProseResult> =>
    ipcRenderer.invoke('skills:prose', request),
  saveSkill: (request: SkillsSaveRequest): Promise<SkillsSaveResult> =>
    ipcRenderer.invoke('skills:save', request),
  addModelAlias: (model: string, aliasOf: string): Promise<{ ok: true }> => ipcRenderer.invoke('models:addAlias', model, aliasOf),
  setModelPrice: (model: string, inputPricePerMillion: number, outputPricePerMillion: number): Promise<{ ok: true }> =>
    ipcRenderer.invoke('models:setPrice', model, inputPricePerMillion, outputPricePerMillion),
  /** Settings › Model aliases CRUD: the current alias config plus removal. */
  getModelAliases: (): Promise<Array<{ model: string; aliasOf: string }>> => ipcRenderer.invoke('models:getAliases'),
  removeModelAlias: (model: string): Promise<{ ok: true }> => ipcRenderer.invoke('models:removeAlias', model),
  /** Settings › Pricing CRUD: the current price-override config plus removal. */
  getPriceOverrides: (): Promise<Array<{ model: string; inputPricePerMillion: number; outputPricePerMillion: number }>> =>
    ipcRenderer.invoke('models:getPriceOverrides'),
  removePriceOverride: (model: string): Promise<{ ok: true }> => ipcRenderer.invoke('models:removePriceOverride', model),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  /** macOS Full Disk Access pane (ADR 0015); a no-op on other platforms. */
  openSystemSettings: (): Promise<boolean> => ipcRenderer.invoke('open-fda-settings'),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke('store:search', query),
  getSettings: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:info'),
  clearData: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:clear'),
  refreshPricing: (): Promise<PricingRefreshResult> => ipcRenderer.invoke('pricing:refresh'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
  /** The active display currency (ADR 0009) — the renderer's only FX read
   * path; it never calls Frankfurter directly. */
  getCurrency: (): Promise<ActiveCurrency> => ipcRenderer.invoke('currency:get'),
  setCurrency: (code: string): Promise<ActiveCurrency> => ipcRenderer.invoke('currency:set', code),
  getCurrencies: (): Promise<CurrencyOption[]> => ipcRenderer.invoke('currency:list'),
  /** Fired when the background FX fetch lands a fresh rate (ADR 0009), so
   * the renderer repaints with the new cached rate without polling. */
  onCurrencyChanged: (callback: (currency: ActiveCurrency) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, currency: ActiveCurrency): void => callback(currency)
    ipcRenderer.on('currency:changed', listener)
    return () => ipcRenderer.removeListener('currency:changed', listener)
  },
  /** CSV/JSON export in the currently selected display currency. With no
   * destination the main process shows a folder/file picker. */
  exportData: (format: 'csv' | 'json', destination?: string): Promise<ExportResult> =>
    ipcRenderer.invoke(`export:${format}`, destination),
  /** Coach agent chain (ticket 21): detected harnesses for the picker. */
  getCoachHarnesses: (): Promise<CoachHarnessesResult> => ipcRenderer.invoke('coach:harnesses'),
  /** Starts a harness run; resolves with the immediate ack. Events stream on
   * `onCoachEvent` keyed by the returned runId. */
  startCoachRun: (request: CoachRunRequest): Promise<CoachRunResult> =>
    ipcRenderer.invoke('coach:run', request),
  /** Interrupts the active run (fire-and-forget). */
  cancelCoachRun: (runId: string): void => ipcRenderer.send('coach:cancel', runId),
  /** The consent gate (ticket 22, ADR 0012 addendum): read/revoke the
   * one-time opt-in that lets ledger-derived data reach a harness provider. */
  getAgentsConsent: (): Promise<AgentsConsentResult> => ipcRenderer.invoke('agents:consent:get'),
  setAgentsConsent: (granted: boolean): Promise<AgentsConsentResult> =>
    ipcRenderer.invoke('agents:consent:set', granted),
  onCoachEvent: (callback: (message: CoachEventEnvelope) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: CoachEventEnvelope): void => callback(message)
    ipcRenderer.on('coach:event', listener)
    return () => ipcRenderer.removeListener('coach:event', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
