import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

import { captureModelPricingCatalogue } from '../src/main/pipeline/models.js'
import { captureProxyPaths } from '../src/main/pipeline/models.js'
import * as viewCalculation from '../src/main/view-aggregate-calculation.js'

const testRequire = createRequire(import.meta.url)
const { measure, measureAsync, measureViewInputProbe, watchNativeStatements } = testRequire(
  '../scripts/measure-query-path.cjs',
) as {
  measure(
    label: string,
    run: () => unknown,
    options: { runs: number; warmup: number; crossesWorkerBoundary: boolean; note?: string },
  ): {
    op: string
    rows: number | null
    cloneBytes: number | null
    cloneBytesMethod: string | null
    samplesMs: number[]
  }
  measureAsync(
    label: string,
    run: () => Promise<unknown>,
    options: { runs: number; warmup: number; crossesWorkerBoundary: boolean; note?: string },
    engine: string,
    instrumentation: { reset(): void; snapshot(): unknown },
  ): Promise<{
    op: string
    rows: number | null
    cloneBytes: number | null
    cloneBytesMethod: string | null
    coldNative: unknown
    warmNative: unknown[]
    samplesMs: number[]
  }>
  measureViewInputProbe(
    runtime: { runPromise(effect: unknown): Promise<unknown> },
    modules: {
      Effect: { flatMap(service: unknown, f: (reads: { getViewData(): unknown }) => unknown): unknown }
      viewReads: { LedgerViewReads: unknown }
      viewCalculation: typeof viewCalculation
    },
    instrumentation: {
      beginSelectRowCapture(): void
      endSelectRowCapture(): {
        nativeStatements: { selectCount: number; connectionIds: number[]; statements: unknown[] }
        rows: unknown[][]
        nativeSqlMs: number
      }
    },
    id: 'store:views' | 'store:analytics',
    calculationInputs: {
      catalogue: ReturnType<typeof captureModelPricingCatalogue>
      proxyPaths: ReturnType<typeof captureProxyPaths>
    },
  ): Promise<{
    phases: {
      read: {
        wallMs: number
        nativeSqlMs: number
        nonSqlReadMs: number
        memory: { rssBytes: number; heapBytes: number }
      }
      calculation: {
        label: string
        wallMs: number
        memory: { rssBytes: number; heapBytes: number }
        output: { resultKeys: string[]; valueKeys: string[]; unpricedModels: number }
        excludes: string[]
      }
    }
    nativeStatements: { selectCount: number }
    selectedRows: number
    rawSelectedSerializedBytes: number
    decodedDtoSerializedBytes: number
  }>
  watchNativeStatements(): {
    reset(): void
    snapshot(): { statements: Array<{ method: string }> }
    beginSelectRowCapture(): void
    endSelectRowCapture(): { nativeSqlMs: number; rows: unknown[][] }
    restore(): void
  }
}

describe('query-path measurement samples', () => {
  it('retains only scalar sample metrics and clones the final warm result', async () => {
    let calls = 0
    const instrumentation = {
      reset() {},
      snapshot() {
        return { statementCount: 0, selectCount: 0, materializedRows: 0, connectionIds: [], statements: [] }
      },
    }
    const result = await measureAsync(
      'store:views',
      async () => {
        calls++
        return calls < 7 ? { unsupported: () => undefined } : { output: 'final warm result' }
      },
      { runs: 5, warmup: 1, crossesWorkerBoundary: true },
      'effect',
      instrumentation,
    )

    expect(calls).toBe(7)
    expect(result.op).toBe('store:views')
    expect(result.cloneBytes).toBeGreaterThan(0)
    expect(result.cloneBytesMethod).toBe('exact: v8.serialize')
    expect(result.rows).toBeNull()
    expect(result.samplesMs).toHaveLength(5)
    expect(result.warmNative).toHaveLength(5)
    expect(result).not.toHaveProperty('value')
    expect(result.coldNative).toMatchObject({ statementCount: 0 })
  })

  it('releases legacy results before the next sample and clones only the final result', () => {
    let calls = 0
    const result = measure(
      'store:views',
      () => {
        calls++
        return calls < 6 ? { unsupported: () => undefined } : { output: 'final legacy result' }
      },
      { runs: 5, warmup: 1, crossesWorkerBoundary: false },
    )

    expect(calls).toBe(6)
    expect(result.op).toBe('store:views')
    expect(result.cloneBytes).toBeGreaterThan(0)
    expect(result.cloneBytesMethod).toBe('exact: v8.serialize')
    expect(result.rows).toBeNull()
    expect(result.samplesMs).toHaveLength(5)
    expect(result).not.toHaveProperty('value')
  })

  it('profiles the real view read and direct calculator on the exact decoded DTO and timed inputs', async () => {
    const dto = { sessions: [], turns: [], calls: [], aliases: [], overrides: [] }
    const calculationInputs = {
      catalogue: captureModelPricingCatalogue(),
      proxyPaths: captureProxyPaths(),
    }
    const nativeStatements = { selectCount: 5, connectionIds: [1], statements: [] }
    const instrumentation = {
      beginSelectRowCapture() {},
      endSelectRowCapture() {
        return { nativeStatements, rows: [[], [], [], [], []], nativeSqlMs: 1 }
      },
    }
    const modules = {
      Effect: { flatMap: () => ({ probe: true }) },
      viewReads: { LedgerViewReads: Symbol('LedgerViewReads') },
      viewCalculation: {
        calculateDashboardViews: vi.fn(viewCalculation.calculateDashboardViews),
        calculateAnalyticalViews: vi.fn(viewCalculation.calculateAnalyticalViews),
      },
    }
    const runtime = { runPromise: async () => dto }

    const dashboard = await measureViewInputProbe(runtime, modules, instrumentation, 'store:views', calculationInputs)
    const analytics = await measureViewInputProbe(
      runtime,
      modules,
      instrumentation,
      'store:analytics',
      calculationInputs,
    )

    expect(dashboard.phases.read.wallMs).toBeGreaterThan(0)
    expect(dashboard.phases.read.nativeSqlMs).toBe(1)
    expect(dashboard.phases.read.nonSqlReadMs).toBeGreaterThanOrEqual(0)
    expect(dashboard.phases.read.memory).toEqual(
      expect.objectContaining({ rssBytes: expect.any(Number), heapBytes: expect.any(Number) }),
    )
    expect(dashboard.phases.calculation.label).toBe('calculateDashboardViews')
    expect(dashboard.phases.calculation.output).toEqual({
      resultKeys: ['unpricedModels', 'value'],
      valueKeys: ['byCategory', 'byModel', 'byProject', 'byProvider', 'costOverTime', 'kpis'],
      unpricedModels: 0,
    })
    expect(analytics.phases.calculation.label).toBe('calculateAnalyticalViews')
    expect(analytics.phases.calculation.output.valueKeys).toEqual([
      'categories',
      'models',
      'providers',
      'skills',
      'subagents',
    ])
    expect(analytics.phases.calculation.excludes).toEqual(['pricing diagnostics', 'wire-schema validation'])
    expect(modules.viewCalculation.calculateDashboardViews).toHaveBeenCalledWith(dto, calculationInputs)
    expect(modules.viewCalculation.calculateAnalyticalViews).toHaveBeenCalledWith(dto, calculationInputs)
    expect(dashboard.nativeStatements.selectCount).toBe(5)
    expect(dashboard.selectedRows).toBe(0)
    expect(dashboard.rawSelectedSerializedBytes).toBeGreaterThan(0)
    expect(dashboard.decodedDtoSerializedBytes).toBeGreaterThan(0)
  })

  it('measures native SQL only during the untimed row capture', () => {
    const { DatabaseSync } = testRequire('node:sqlite') as typeof import('node:sqlite')
    const instrumentation = watchNativeStatements()
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE sample (value INTEGER)')
      database.prepare('INSERT INTO sample VALUES (?)').run(1)
      instrumentation.reset()
      database.prepare('SELECT value FROM sample').all()
      expect(instrumentation.snapshot().statements).toHaveLength(1)
      instrumentation.beginSelectRowCapture()
      const rows = database.prepare('SELECT value FROM sample').all()
      const captured = instrumentation.endSelectRowCapture()

      expect(captured.nativeSqlMs).toBeGreaterThanOrEqual(0)
      expect(captured.rows).toEqual([rows])
      expect(instrumentation.snapshot().statements).toHaveLength(1)
    } finally {
      database.close()
      instrumentation.restore()
    }
  })
})
