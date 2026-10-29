import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  dataStartForSessions,
  inScope,
  localDateKey,
  localDateKeys,
  overviewDateRange,
  overviewQueryRanges,
  periodWindowStart,
  scopeDateRange,
} from '../src/core/domain/sessions/overview-scope.js'
import type { SessionSummary } from '../src/core/domain/observations/types.js'
import { candidateTimestampBounds } from '../src/infrastructure/sqlite/scoped-snapshot-sql.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'

function session(firstTimestamp: string, providers: string[] = []): SessionSummary {
  return {
    firstTimestamp,
    turns: providers.map(provider => ({ assistantCalls: [{ provider }] })),
  } as unknown as SessionSummary
}

describe('overview scope module boundary', () => {
  it('depends only on pure calendar helpers and domain types', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/core/domain/sessions/overview-scope.ts'), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])

    expect(imports).toEqual(['date-fns', '../../../shared/schemas/overview.js', '../observations/types.js'])
  })
})

describe('local calendar windows', () => {
  it.each(['today', 'week', '30days', 'month', 'all'] as const)(
    'uses the calculation window for %s reads without mutating the captured clock',
    period => {
      const now = new Date(2026, 0, 31, 12, 34, 56)
      const captured = now.getTime()
      const { range, readRange } = overviewQueryRanges({ period }, now)

      expect(readRange).toBe(range)
      expect(range).toEqual(overviewDateRange({ period }, now))
      expect(now.getTime()).toBe(captured)
    },
  )

  it('keeps lifetime reads unbounded and gives custom ranges precedence', () => {
    const now = new Date(2026, 0, 31, 12)
    expect(overviewQueryRanges({ period: 'lifetime' }, now)).toEqual({
      range: { start: new Date(1970, 0, 1), end: new Date(2026, 0, 31, 23, 59, 59, 999) },
      readRange: undefined,
    })
    const { range, readRange } = overviewQueryRanges(
      { period: 'lifetime', range: { since: '2026-01-01', until: '2026-01-03' } },
      now,
    )
    expect(readRange).toBe(range)
    expect(range).toEqual({ start: new Date(2026, 0, 1), end: new Date(2026, 0, 3, 23, 59, 59, 999) })
  })

  it('starts the six-month window at a month boundary even from the 31st', () => {
    expect(periodWindowStart('all', new Date(2026, 7, 31, 12))).toBe('2026-02-01')
    expect(periodWindowStart('30days', new Date(2024, 2, 1, 12))).toBe('2024-01-31')
  })

  it.each([
    [new Date(2026, 2, 30, 0, 30), '2026-03-23'],
    [new Date(2026, 9, 26, 0, 30), '2026-10-19'],
    [new Date(2026, 2, 9, 0, 30), '2026-03-02'],
    [new Date(2026, 10, 2, 0, 30), '2026-10-26'],
  ] as const)('keeps calendar weeks across clock changes at %s', (now, expected) => {
    expect(periodWindowStart('week', now)).toBe(expected)
  })

  it('generates inclusive chart days across leap days and clock changes', () => {
    expect(localDateKeys('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
    expect(localDateKeys('2026-03-28', '2026-03-30')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    expect(localDateKeys('2026-10-24', '2026-10-26')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26'])
    expect(localDateKeys('2026-01-01', '2026-01-01')).toEqual(['2026-01-01'])
    expect(localDateKeys('2026-01-03', '2026-01-01')).toEqual([])
    expect(localDateKeys('invalid', 'invalid')).toEqual([])
  })

  it('includes the final chart day after historical midnight clock changes', () => {
    const keys = localDateKeys('1970-01-01', '2026-07-10')
    expect(keys).toHaveLength(20_645)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe('1970-01-01')
    expect(keys.at(-1)).toBe('2026-07-10')
  })

  it.each([new Date(2026, 2, 29), new Date(2026, 9, 25), new Date(2026, 2, 8), new Date(2026, 10, 1)])(
    'pads SQL candidates by exactly 24 elapsed hours around %s',
    now => {
      const range = overviewDateRange({ period: 'today' }, now)
      const [from, to] = candidateTimestampBounds(range)
      expect(range.start.getTime() - Date.parse(from)).toBe(86_400_000)
      expect(Date.parse(to) - range.end.getTime()).toBe(86_400_000)
    },
  )

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
