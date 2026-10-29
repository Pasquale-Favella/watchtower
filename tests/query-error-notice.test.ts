import { RegistryContext } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { RpcQuerySlot } from '../src/renderer/stores/atoms/rpc-query.js'
import { overviewQuery } from '../src/renderer/features/overview/atoms.js'
import { OverviewView } from '../src/renderer/features/overview/OverviewView.js'
import {
  PROVIDERS_REQUEST,
  providersQuery,
  SETTINGS_INFO_REQUEST,
  settingsInfoQuery,
} from '../src/renderer/features/settings/capability-atoms.js'
import { GeneralPane } from '../src/renderer/features/settings/general-pane.js'
import { PrivacyPane } from '../src/renderer/features/settings/privacy-pane.js'
import { ProvidersPane } from '../src/renderer/features/settings/providers-pane.js'
import { QueryErrorNotice } from '../src/renderer/components/QueryErrorNotice.js'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip.js'
import type { SettingsInfo } from '../src/shared/schemas/ipc.js'
import type { OverviewPayload } from '../src/shared/schemas/overview.js'
import type { AnalyticalViews } from '../src/shared/schemas/views.js'

const payload: OverviewPayload = {
  kpis: {
    cost: 42,
    calls: 1,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    savingsUSD: 0,
    estimatedCostUSD: 0,
    oneShotRate: null,
    cacheHitPercent: 0,
  },
  daily: [],
  dataStart: null,
  models: [],
  activities: [],
  tools: [],
  mcpServers: [],
  skills: [],
  subagents: [],
  efficiency: {
    score: 0,
    grade: 'F',
    oneShotRate: null,
    pricingCoverage: 0,
    retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
    routingWaste: { baselineModel: '', baselineCostPerEdit: 0, totalSavingsUSD: 0, byModel: [] },
  },
  workflow: { corrections: 0, userTurns: 0, correctionRate: null, medianTimeToFirstEditMs: null, topReworkedFiles: [] },
  unpricedModels: [],
  localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
}

function renderFailedOverview(previous?: OverviewPayload): string {
  const failure = AsyncResult.fail(
    new RpcClientError({
      reason: new RpcClientDefect({ message: 'RPC port disconnected', cause: new Error('closed') }),
    }),
    {
      previousSuccess: previous === undefined ? Option.none() : Option.some(AsyncResult.success(previous)),
    },
  )
  const registry = AtomRegistry.make({
    initialValues: [
      [overviewQuery.requestAtom, { period: 'today' }],
      [overviewQuery.resultAtom, failure],
    ],
  })
  try {
    return renderToStaticMarkup(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(TooltipProvider, null, createElement(OverviewView)),
      ),
    )
  } finally {
    registry.dispose()
  }
}

function renderWithRetainedQueryError<Request, Value, Error>(
  query: RpcQuerySlot<Request, Value, Error>,
  request: Request,
  previous: Value,
  element: React.ReactElement,
): string {
  const failure = AsyncResult.fail(
    new RpcClientError({
      reason: new RpcClientDefect({ message: 'RPC port disconnected', cause: new Error('closed') }),
    }),
    { previousSuccess: Option.some(AsyncResult.success(previous)) },
  ) as AsyncResult.AsyncResult<Value, Error>
  const registry = AtomRegistry.make({
    initialValues: [
      [query.requestAtom, request],
      [query.resultAtom, failure],
    ] as const,
  })
  try {
    return renderToStaticMarkup(createElement(RegistryContext.Provider, { value: registry }, element))
  } finally {
    registry.dispose()
  }
}

describe('QueryErrorNotice', () => {
  it('renders the actual Overview payload and a nonblocking error after a failed refresh', () => {
    const markup = renderFailedOverview(payload)
    expect(markup).toContain('Total spend')
    expect(markup).toContain('$42.00')
    expect(markup).toContain('Refresh failed: Application connection unavailable. Reconnecting.')
    expect(markup).not.toContain('role="alert"')
  })

  it('renders the actual Overview first-load failure without stale metrics', () => {
    const markup = renderFailedOverview()
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Application connection unavailable. Reconnecting.')
    expect(markup).not.toContain('Total spend')
  })
  it('keeps retained view content visible beside a nonblocking refresh error', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'main',
        null,
        createElement('section', null, 'Previously loaded analytics'),
        createElement(QueryErrorNotice, { error: 'Refresh failed', hasData: true }),
      ),
    )

    expect(markup).toContain('Previously loaded analytics')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Refresh failed: Refresh failed')
    expect(markup).not.toContain('role="alert"')
  })

  it('keeps the blocking alert for an error before the first payload', () => {
    const markup = renderToStaticMarkup(
      createElement(QueryErrorNotice, { error: 'Unable to load data', hasData: false }),
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Unable to load data')
    expect(markup).not.toContain('role="status"')
  })

  it('keeps detected providers visible with a nonblocking refresh error', () => {
    const analytics: AnalyticalViews = {
      providers: [{ name: 'claude', cost: 1.25, calls: 2, sessions: 3 }],
      models: [],
      categories: [],
      skills: [],
      subagents: [],
    }
    const markup = renderWithRetainedQueryError(
      providersQuery,
      PROVIDERS_REQUEST,
      analytics,
      createElement(ProvidersPane),
    )

    expect(markup).toContain('Claude')
    expect(markup).toContain('2 calls')
    expect(markup).toContain('Refresh failed: Application connection unavailable. Reconnecting.')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })

  it('keeps General settings and retained Claude config visible with a refresh error', () => {
    const settings: SettingsInfo = {
      dataDir: '/data/watchtower',
      dbSize: 10,
      dataDirSize: 20,
      cacheDir: '/cache',
      cacheSize: 5,
      claudeConfigDirs: ['/config/claude'],
    }
    const markup = renderWithRetainedQueryError(
      settingsInfoQuery,
      SETTINGS_INFO_REQUEST,
      settings,
      createElement(GeneralPane),
    )

    expect(markup).toContain('Theme')
    expect(markup).toContain('Active config')
    expect(markup).toContain('Refresh failed: Application connection unavailable. Reconnecting.')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })

  it('keeps Privacy store details visible with a settings refresh error', () => {
    const settings: SettingsInfo = {
      dataDir: '/data/watchtower',
      dbSize: 10,
      dataDirSize: 20,
      cacheDir: '/cache',
      cacheSize: 5,
    }
    const markup = renderWithRetainedQueryError(
      settingsInfoQuery,
      SETTINGS_INFO_REQUEST,
      settings,
      createElement(PrivacyPane),
    )

    expect(markup).toContain('/data/watchtower')
    expect(markup).toContain('Database size')
    expect(markup).toContain('Refresh failed: Application connection unavailable. Reconnecting.')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })
})
