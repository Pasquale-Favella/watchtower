import { RegistryContext } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { QueryErrorNotice } from '../src/renderer/src/shared/components/QueryErrorNotice.js'
import { overviewQuery } from '../src/renderer/src/features/overview/atoms.js'
import { OverviewView } from '../src/renderer/src/features/overview/OverviewView.js'
import { TooltipProvider } from '../src/renderer/src/shared/components/ui/tooltip.js'
import { RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'
import type { OverviewPayload } from '../src/shared/schemas/overview.js'

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
    new RendererApiError({ operation: 'overview:query', message: 'Connection unavailable' }),
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

describe('QueryErrorNotice', () => {
  it('renders the actual Overview payload and a nonblocking error after a failed refresh', () => {
    const markup = renderFailedOverview(payload)
    expect(markup).toContain('Total spend')
    expect(markup).toContain('$42.00')
    expect(markup).toContain('Refresh failed: Connection unavailable')
    expect(markup).not.toContain('role="alert"')
  })

  it('renders the actual Overview first-load failure without stale metrics', () => {
    const markup = renderFailedOverview()
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Connection unavailable')
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
})
