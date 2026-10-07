import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const { measure, measureAsync } = createRequire(import.meta.url)('../scripts/measure-query-path.cjs') as {
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
})
