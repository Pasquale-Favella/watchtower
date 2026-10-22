import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as bridge from './api.js'

export class RendererApiError extends Data.TaggedError('RendererApiError')<{
  readonly operation: string
  readonly message: string
}> {}

/** The Promise facade is confined to this migration adapter until RPC replaces it. */
function adapt<Args extends unknown[], A>(
  operation: string,
  invoke: (...args: Args) => Promise<bridge.ApiResult<A>>,
): (...args: Args) => Effect.Effect<A, RendererApiError> {
  return (...args) =>
    Effect.tryPromise({
      try: () => invoke(...args),
      catch: () => new RendererApiError({ operation, message: 'Unable to reach the application.' }),
    }).pipe(
      Effect.flatMap(result =>
        result.ok
          ? Effect.succeed(result.data)
          : Effect.fail(new RendererApiError({ operation, message: result.error })),
      ),
    )
}

export const legacyRendererApi = {
  getScanStatus: adapt('store:status', bridge.fetchScanStatus),
  getScanActive: adapt('scan:active', bridge.fetchScanActive),
  getViews: adapt('store:views', bridge.fetchViews),
  getProjects: adapt('store:projects', bridge.fetchProjects),
  getSessions: adapt('store:sessions', bridge.fetchSessions),
  getSession: adapt('store:session', bridge.fetchSession),
  getAnalytics: adapt('store:analytics', bridge.fetchAnalytics),
  getOverview: adapt('overview:query', bridge.fetchOverview),
  getSessionRows: adapt('sessions:view', bridge.fetchSessionRows),
  getPullRequests: adapt('pullRequests:view', bridge.fetchPullRequests),
  getSpend: adapt('spend:view', bridge.fetchSpend),
  getModels: adapt('models:view', bridge.fetchModels),
  getCompare: adapt('compare:view', bridge.fetchCompare),
  getOptimize: adapt('optimize:view', bridge.fetchOptimize),
  getYield: adapt('optimize:yield', bridge.fetchYield),
  getSkills: adapt('skills:view', bridge.fetchSkills),
  dismissSkill: adapt('skills:dismiss', bridge.fetchDismissSkill),
  saveSkill: adapt('skills:save', bridge.fetchSaveSkill),
  getModelAliases: adapt('models:getAliases', bridge.fetchModelAliases),
  getPriceOverrides: adapt('models:getPriceOverrides', bridge.fetchPriceOverrides),
  addModelAlias: adapt('models:addAlias', bridge.fetchAddModelAlias),
  removeModelAlias: adapt('models:removeAlias', bridge.fetchRemoveModelAlias),
  setModelPrice: adapt('models:setPrice', bridge.fetchSetModelPrice),
  removePriceOverride: adapt('models:removePriceOverride', bridge.fetchRemovePriceOverride),
  getSettings: adapt('settings:info', bridge.fetchSettings),
  clearData: adapt('settings:clear', bridge.fetchClearData),
  getLedgerMcpStatus: adapt('ledger-mcp:status', bridge.fetchLedgerMcpStatus),
  setLedgerMcpStartupMode: adapt('ledger-mcp:startup:set', bridge.fetchSetLedgerMcpStartupMode),
  getLedgerMcpConnection: adapt('ledger-mcp:connection', bridge.fetchLedgerMcpConnection),
  regenerateLedgerMcpToken: adapt('ledger-mcp:token:regenerate', bridge.fetchRegenerateLedgerMcpToken),
  refreshPricing: adapt('pricing:refresh', bridge.fetchRefreshPricing),
  checkForUpdates: adapt('updates:check', bridge.fetchCheckForUpdates),
  getUpdateStatus: adapt('updates:status', bridge.fetchUpdateStatus),
  downloadUpdate: adapt('updates:download', bridge.fetchDownloadUpdate),
  installUpdate: adapt('updates:install', bridge.fetchInstallUpdate),
  openExternal: adapt('open-external', bridge.openExternalUrl),
  getCurrency: adapt('currency:get', bridge.fetchCurrency),
  setCurrency: adapt('currency:set', bridge.fetchSetCurrency),
  getCurrencies: adapt('currency:list', bridge.fetchCurrencies),
  getCadence: adapt('cadence:get', bridge.fetchCadence),
  setCadence: adapt('cadence:set', bridge.fetchSetCadence),
  getAppVersion: adapt('app:version', bridge.fetchAppVersion),
  search: adapt('store:search', bridge.fetchSearch),
  exportData: adapt('export', bridge.fetchExport),
  scan: adapt('scan:start', bridge.fetchScan),
  getCoachHarnesses: adapt('coach:harnesses', bridge.fetchCoachHarnesses),
  refreshCoachHarnesses: adapt('coach:harnesses-refresh', bridge.refreshCoachHarnesses),
  openCoachLoginTerminal: adapt('coach:open-login-terminal', bridge.openCoachLoginTerminal),
  inspectCoachHarness: adapt('coach:inspect', bridge.fetchCoachInspect),
  startCoachRun: adapt('coach:run', bridge.fetchCoachRun),
  getOrbPlacement: adapt('orb:placement:get', bridge.fetchOrbPlacement),
  requestOrbPanel: adapt('orb:panel:request', bridge.fetchOrbPanelRequest),
}

export class RendererApi extends Context.Service<RendererApi, typeof legacyRendererApi>()(
  'watchtower/renderer/RendererApi',
) {
  static readonly layer = Layer.succeed(RendererApi, legacyRendererApi)
}
