import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ScanMetadata } from '../shared/schemas/scan.js'
import type {
  DashboardViews,
  SessionDetail,
  SessionRow,
  ProjectRow,
  AnalyticalViews,
  SearchHit,
} from '../main/views.js'
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
  LedgerMcpConnection,
  LedgerMcpStatus,
} from '../shared/schemas/ipc.js'
import type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachHarnessesResult,
  CoachLoginTerminalResult,
  CoachInspectRequest,
  CoachInspectResult,
  CoachRunRequest,
  CoachRunResult,
} from '../shared/schemas/agents.js'
import type { Section } from '../shared/schemas/navigation.js'
import type { OrbPanelRequest, OrbPlacement } from '../shared/schemas/orb.js'

export type {
  PricingRefreshResult,
  ScanProgressMessage,
  ScanResult,
  ScanStatus,
  SettingsInfo,
  StoreChangedMessage,
  LedgerMcpConnection,
  LedgerMcpStatus,
} from '../shared/schemas/ipc.js'
export type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachHarnessesResult,
  CoachLoginTerminalResult,
  CoachInspectResult,
  CoachRunRequest,
  CoachRunResult,
} from '../shared/schemas/agents.js'

const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  platform: process.platform,
  scan: (options?: { provider?: string }): Promise<ScanResult> => ipcRenderer.invoke('scan:start', options),
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
  /** Whether a scan is in flight right now (main-owned, app-wide): a window
   * reads it once at boot, then follows the scan lifecycle broadcasts. */
  getScanActive: (): Promise<boolean> => ipcRenderer.invoke('scan:active'),
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
  getPullRequests: (scope: OverviewScope): Promise<PullRequestsPayload | null> =>
    ipcRenderer.invoke('pullRequests:view', scope),
  getSpend: (scope: OverviewScope): Promise<SpendPayload | null> => ipcRenderer.invoke('spend:view', scope),
  getModels: (scope: OverviewScope): Promise<ModelsPayload | null> => ipcRenderer.invoke('models:view', scope),
  getCompare: (scope: OverviewScope, pair?: ComparePair): Promise<ComparePayload | null> =>
    ipcRenderer.invoke('compare:view', scope, pair),
  getOptimize: (scope: OverviewScope): Promise<OptimizePayload | null> => ipcRenderer.invoke('optimize:view', scope),
  getYield: (scope: OverviewScope): Promise<YieldPayload | null> => ipcRenderer.invoke('optimize:yield', scope),
  getSkills: (scope: OverviewScope, thresholds?: SkillsThresholds): Promise<SkillsPayload | null> =>
    ipcRenderer.invoke('skills:view', scope, thresholds),
  dismissSkill: (request: SkillsDismissalRequest): Promise<SkillsDismissalResult> =>
    ipcRenderer.invoke('skills:dismiss', request),
  saveSkill: (request: SkillsSaveRequest): Promise<SkillsSaveResult> => ipcRenderer.invoke('skills:save', request),
  addModelAlias: (model: string, aliasOf: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('models:addAlias', model, aliasOf),
  setModelPrice: (model: string, inputPricePerMillion: number, outputPricePerMillion: number): Promise<{ ok: true }> =>
    ipcRenderer.invoke('models:setPrice', model, inputPricePerMillion, outputPricePerMillion),
  /** Settings › Model aliases CRUD: the current alias config plus removal. */
  getModelAliases: (): Promise<Array<{ model: string; aliasOf: string }>> => ipcRenderer.invoke('models:getAliases'),
  removeModelAlias: (model: string): Promise<{ ok: true }> => ipcRenderer.invoke('models:removeAlias', model),
  /** Settings › Pricing CRUD: the current price-override config plus removal. */
  getPriceOverrides: (): Promise<
    Array<{ model: string; inputPricePerMillion: number; outputPricePerMillion: number }>
  > => ipcRenderer.invoke('models:getPriceOverrides'),
  removePriceOverride: (model: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('models:removePriceOverride', model),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  /** macOS Full Disk Access pane (ADR 0015); a no-op on other platforms. */
  openSystemSettings: (): Promise<boolean> => ipcRenderer.invoke('open-fda-settings'),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke('store:search', query),
  getSettings: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:info'),
  clearData: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:clear'),
  getLedgerMcpStatus: (): Promise<LedgerMcpStatus> => ipcRenderer.invoke('ledger-mcp:status'),
  setLedgerMcpStartupMode: (mode: 'on-demand' | 'at-launch'): Promise<LedgerMcpStatus> =>
    ipcRenderer.invoke('ledger-mcp:startup:set', mode),
  getLedgerMcpConnection: (): Promise<LedgerMcpConnection> => ipcRenderer.invoke('ledger-mcp:connection'),
  regenerateLedgerMcpToken: (): Promise<LedgerMcpStatus> => ipcRenderer.invoke('ledger-mcp:token:regenerate'),
  refreshPricing: (): Promise<PricingRefreshResult> => ipcRenderer.invoke('pricing:refresh'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
  /** Renderer tripwire forward (#130): a dropped subscription payload is
   * filed with its label + location only — never contents. Fire-and-forget
   * from the renderer's side; a rejected forward never breaks rendering. */
  notifyNotice: (label: string, location: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('log:notice', { label, location }),
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
  /** Coach & Skills agent chain (ADR 0017, map 53): detected harnesses for the
   * picker. There is no workspace picker — runs use a private temp workspace
   * owned by the main process, and the harness reads platform data through the
   * in-app ledger MCP server. */
  getCoachHarnesses: (): Promise<CoachHarnessesResult> => ipcRenderer.invoke('coach:harnesses'),
  openCoachLoginTerminal: (instanceId: string): Promise<CoachLoginTerminalResult> =>
    ipcRenderer.invoke('coach:open-login-terminal', instanceId),
  refreshCoachHarnesses: (): Promise<CoachHarnessesResult> => ipcRenderer.invoke('coach:harnesses-refresh'),
  onCoachHarnessesChanged: (callback: (rows: CoachHarnessRow[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, rows: CoachHarnessRow[]): void => callback(rows)
    ipcRenderer.on('coach:harnesses-changed', listener)
    return () => ipcRenderer.removeListener('coach:harnesses-changed', listener)
  },
  /** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
   * models/modes without a run, so the model/mode pickers render before the
   * first message. A failed probe is `{ ok: false }` — the pickers stay
   * absent and the first run surfaces the real error. */
  inspectCoachHarness: (request: CoachInspectRequest): Promise<CoachInspectResult> =>
    ipcRenderer.invoke('coach:inspect', request),
  /** Starts a harness run; resolves with the immediate ack. Events stream on
   * `onCoachEvent` keyed by the returned runId. */
  startCoachRun: (request: CoachRunRequest): Promise<CoachRunResult> => ipcRenderer.invoke('coach:run', request),
  /** Interrupts the active run (fire-and-forget). */
  cancelCoachRun: (runId: string): void => ipcRenderer.send('coach:cancel', runId),
  /** Brand-new conversation: cancels active runs and cleans the temp workspace
   * (fire-and-forget; the store calls it on resetSession). */
  resetCoachWorkspace: (): void => ipcRenderer.send('coach:reset'),
  /** Streams one CoachEvent per broadcast, enveloped with the runId it belongs
   * to, so the renderer routes concurrent runs without mixing deltas. */
  onCoachEvent: (callback: (message: CoachEventEnvelope) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, message: CoachEventEnvelope): void => callback(message)
    ipcRenderer.on('coach:event', listener)
    return () => ipcRenderer.removeListener('coach:event', listener)
  },
  /** Main window: the background orb asked to open the app on a section. */
  onNavigate: (callback: (section: Section) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, section: Section): void => callback(section)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  /** The floating background orb's window controls. The main process ignores
   * these from any window but the orb's own two (the orb and its panel). */
  orb: {
    getPlacement: (): Promise<OrbPlacement | null> => ipcRenderer.invoke('orb:placement:get'),
    /** Asks the main process to open (`open`: focused, `peek`: not) or fold the panel. */
    requestPanel: (request: OrbPanelRequest): Promise<OrbPlacement | null> =>
      ipcRenderer.invoke('orb:panel:request', request),
    dragStart: (): void => ipcRenderer.send('orb:drag-start'),
    dragMove: (dx: number, dy: number): void => ipcRenderer.send('orb:drag-move', dx, dy),
    dragEnd: (): void => ipcRenderer.send('orb:drag-end'),
    openApp: (section?: Section): void => ipcRenderer.send('orb:open-app', section),
    hide: (): void => ipcRenderer.send('orb:hide'),
    quit: (): void => ipcRenderer.send('orb:quit'),
    /** The panel painted its first frame after opening (flicker-free reveal). */
    panelPainted: (): void => ipcRenderer.send('orb:panel-painted'),
    /** The panel's data is loaded: the first-close peek may open (main decides). */
    panelDataReady: (): void => ipcRenderer.send('orb:panel-data-ready'),
    onPlacement: (callback: (placement: OrbPlacement) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, placement: OrbPlacement): void => callback(placement)
      ipcRenderer.on('orb:placement', listener)
      return () => ipcRenderer.removeListener('orb:placement', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
