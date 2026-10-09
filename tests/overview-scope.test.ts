import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  dataStartForSessions,
  inScope,
  localDateKey,
  overviewDateRange,
  periodWindowStart,
  scopeDateRange,
} from '../src/main/overview-scope.js'
import type { SessionSummary } from '../src/main/pipeline/types.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'

function session(firstTimestamp: string, providers: string[] = []): SessionSummary {
  return {
    firstTimestamp,
    turns: providers.map(provider => ({ assistantCalls: [{ provider }] })),
  } as unknown as SessionSummary
}

describe('overview scope module boundary', () => {
  it('has no runtime or IO imports', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/overview-scope.ts'), 'utf8')
    const imports = source.match(/^import\s+.*$/gm) ?? []

    expect(imports).toEqual([
      "import type { OverviewPeriod, OverviewScope } from '../shared/schemas/overview.js'",
      "import type { DateRange, SessionSummary } from './pipeline/types.js'",
    ])
  })
})

describe('local calendar windows', () => {
  it('ends detector periods at the captured instant', () => {
    const now = new Date(2026, 0, 3, 12, 34, 56, 789)

    expect(scopeDateRange({ period: 'week' }, now)).toEqual({
      start: new Date(2025, 11, 27),
      end: now,
    })
    expect(scopeDateRange({ period: 'lifetime' }, now)).toEqual({
      start: new Date(1970, 0, 1),
      end: now,
    })
  })

  it('ends custom detector periods at the final local day', () => {
    const scope: OverviewScope = {
      period: 'today',
      range: { since: '2025-12-31', until: '2026-01-02' },
    }

    expect(scopeDateRange(scope, new Date(2026, 0, 3, 12))).toEqual({
      start: new Date(2025, 11, 31),
      end: new Date(2026, 0, 2, 23, 59, 59, 999),
    })
  })

  it('formats local dates and crosses month and year boundaries', () => {
    expect(localDateKey(new Date(2026, 0, 3, 12))).toBe('2026-01-03')
    expect(periodWindowStart('week', new Date(2026, 0, 3, 12))).toBe('2025-12-27')
    expect(periodWindowStart('30days', new Date(2026, 0, 3, 12))).toBe('2025-12-04')
    expect(periodWindowStart('all', new Date(2026, 0, 3, 12))).toBe('2025-07-01')
  })

  it('maps a period to local midnight through the end of the current day', () => {
    const now = new Date(2026, 0, 3, 12, 34, 56, 789)
    const range = overviewDateRange({ period: 'week' }, now)

    expect(range.start.getFullYear()).toBe(2025)
    expect(range.start.getMonth()).toBe(11)
    expect(range.start.getDate()).toBe(27)
    expect([
      range.start.getHours(),
      range.start.getMinutes(),
      range.start.getSeconds(),
      range.start.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0])
    expect([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()]).toEqual([2026, 0, 3])
    expect([range.end.getHours(), range.end.getMinutes(), range.end.getSeconds(), range.end.getMilliseconds()]).toEqual(
      [23, 59, 59, 999],
    )
  })

  it('keeps custom date range endpoints inclusive and local', () => {
    const scope: OverviewScope = {
      period: 'today',
      range: { since: '2025-12-31', until: '2026-01-02' },
    }
    const range = overviewDateRange(scope, new Date(2026, 0, 3, 12))

    expect([range.start.getFullYear(), range.start.getMonth(), range.start.getDate()]).toEqual([2025, 11, 31])
    expect([
      range.start.getHours(),
      range.start.getMinutes(),
      range.start.getSeconds(),
      range.start.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0])
    expect([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()]).toEqual([2026, 0, 2])
    expect([range.end.getHours(), range.end.getMinutes(), range.end.getSeconds(), range.end.getMilliseconds()]).toEqual(
      [23, 59, 59, 999],
    )
  })
})

describe('inScope', () => {
  const now = new Date(2026, 0, 3, 12)

  it('includes both custom-range boundary days based on the session first local date', () => {
    const scope: OverviewScope = { period: 'lifetime', range: { since: '2025-12-31', until: '2026-01-02' } }

    expect(inScope(session(new Date(2025, 11, 31, 23, 59).toISOString()), scope, now, undefined)).toBe(true)
    expect(inScope(session(new Date(2026, 0, 2, 0, 1).toISOString()), scope, now, undefined)).toBe(true)
    expect(inScope(session(new Date(2025, 11, 30, 23, 59).toISOString()), scope, now, undefined)).toBe(false)
    expect(inScope(session(new Date(2026, 0, 3, 0, 1).toISOString()), scope, now, undefined)).toBe(false)
  })

  it('includes the period start and today, excludes future dates, and matches any assistant-call provider', () => {
    const scope: OverviewScope = { period: 'week' }

    expect(inScope(session(new Date(2025, 11, 27, 23, 59).toISOString(), ['claude']), scope, now, 'claude')).toBe(true)
    expect(
      inScope(session(new Date(2026, 0, 3, 23, 59).toISOString(), ['opencode', 'claude']), scope, now, 'claude'),
    ).toBe(true)
    expect(inScope(session(new Date(2025, 11, 26, 23, 59).toISOString(), ['claude']), scope, now, 'claude')).toBe(false)
    expect(inScope(session(new Date(2026, 0, 4, 0, 1).toISOString(), ['claude']), scope, now, 'claude')).toBe(false)
    expect(inScope(session(new Date(2026, 0, 2, 12).toISOString(), ['opencode']), scope, now, 'claude')).toBe(false)
    expect(inScope(session(new Date(2026, 0, 2, 12).toISOString()), scope, now, undefined)).toBe(true)
  })

  it('excludes invalid session timestamps', () => {
    expect(inScope(session('not-a-date', ['claude']), { period: 'lifetime' }, now, undefined)).toBe(false)
  })
})

describe('dataStartForSessions', () => {
  it('returns the earliest valid local session date and ignores invalid timestamps', () => {
    expect(
      dataStartForSessions([
        session(new Date(2026, 0, 2, 10).toISOString()),
        session('not-a-date'),
        session(new Date(2025, 11, 31, 22).toISOString()),
      ]),
    ).toBe('2025-12-31')
    expect(dataStartForSessions([session('not-a-date')])).toBeNull()
  })
})
