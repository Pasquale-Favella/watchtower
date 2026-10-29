import { describe, expect, it } from 'vitest'

import { detectSessionOutliers } from '../src/core/analytics/detectors/optimize-calculation.js'
import { groupSummariesIntoProjects } from '../src/core/analytics/projections/aggregate-calculation.js'
import { buildFixtureReport } from './fixtures/report.js'

describe('Optimize cost comparison provenance', () => {
  it('does not compare an estimated session with counted-cost peers', () => {
    const base = buildFixtureReport()[0]!.sessions[0]!
    const sessions = [1, 1, 1, 100].map((cost, index) => ({
      ...base,
      sessionId: `cohort-${index}`,
      totalCostUSD: cost,
      totalEstimatedCostUSD: index === 3 ? cost : 0,
    }))
    expect(detectSessionOutliers(groupSummariesIntoProjects(sessions))).toBeNull()
  })

  it('compares estimated sessions when they have their own sufficient cohort', () => {
    const base = buildFixtureReport()[0]!.sessions[0]!
    const sessions = [1, 1, 100].map((cost, index) => ({
      ...base,
      sessionId: `cohort-${index}`,
      totalCostUSD: cost,
      totalEstimatedCostUSD: cost,
    }))
    expect(detectSessionOutliers(groupSummariesIntoProjects(sessions))).toMatchObject({
      id: 'cost-outliers',
      quantity: { value: 1, unit: 'sessions' },
    })
  })
})
