import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeOperationalLog,
  initOperationalLog,
  makeOperationalLogTracer,
  OperationalLogTracerLayer,
  SPAN_EVENT,
} from '../src/main/operational-log.js'

/**
 * A7: the Operational-log `Tracer`. The proof is the FILE, not a spy — every
 * case reads the emitted JSON lines back, so each one also proves
 * `sanitizeOperationalRecord` ran on the way out. `isPackaged: false`
 * everywhere because the writer is the file-level enforcement point and a
 * packaged build drops `debug` (spans file at `debug` on purpose); the dev
 * echo is the one that can show them.
 */

let dir = ''

afterEach(() => {
  try {
    closeOperationalLog()
  } catch {
    /* not initialised */
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function tempLogDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'watchtower-span-'))
  return join(dir, 'logs')
}

function readRecords(logDir: string): Array<Record<string, unknown>> {
  const files = readdirSync(logDir).filter(f => f.startsWith('operational'))
  const lines: string[] = []
  for (const file of files) {
    lines.push(
      ...readFileSync(join(logDir, file), 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0),
    )
  }
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
}

function readRaw(logDir: string): string {
  return readdirSync(logDir)
    .filter(f => f.startsWith('operational'))
    .map(f => readFileSync(join(logDir, f), 'utf8'))
    .join('\n')
}

/** A bare span, built directly, so `endTime` is chosen rather than clocked.
 * Attributes go on through `span.attribute` because the `Tracer.span` options
 * carry no attributes — the core adds them the same way
 * (`internal/effect.js:2679`). */
function startSpan(
  tracer: Tracer.Tracer,
  name: string,
  startTime: bigint,
  attributes: Record<string, unknown> = {},
  parent: Tracer.AnySpan = Tracer.externalSpan({ spanId: '0'.repeat(16), traceId: '0'.repeat(32) }),
): Tracer.Span {
  const span = tracer.span({
    name,
    parent: Option.some(parent),
    annotations: Context.empty(),
    links: [],
    startTime,
    kind: 'internal',
    root: false,
    sampled: true,
  })
  for (const [key, value] of Object.entries(attributes)) span.attribute(key, value)
  return span
}

describe('A7 Operational-log Tracer: one record per span END', () => {
  it('files exactly one debug record per ended span, with name, kind, ids and duration', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const tracer = makeOperationalLogTracer('main')
    // Chosen, not clocked: 2_500_000ns of a 1_000_000ns start is exactly 2.5ms.
    const span = startSpan(tracer, 'HttpFetch.fetch', 1_000_000n)
    span.end(3_500_000n, Exit.succeed('ok'))
    closeOperationalLog()

    const records = readRecords(logDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      context: 'main',
      event: SPAN_EVENT,
      op: 'HttpFetch.fetch',
      kind: 'internal',
      durationMs: 2.5,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      parentSpanId: '0000000000000000',
      level: 'debug',
      time: expect.any(String),
    })
  })

  it('files nothing for a span that never ends — the start is never written', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    startSpan(makeOperationalLogTracer('main'), 'never.ended', 1_000_000n)
    closeOperationalLog()
    // A start line per span would double the file volume for no diagnostic
    // gain, so the flipped assertion IS the property: this is 0, not 1.
    expect(readRecords(logDir)).toHaveLength(0)
  })

  it('a failing span files the error code and never the message', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const secret = 'user asked: what did I spend on gpt-5? ($456.78, C:\\Users\\alice)'
    const span = startSpan(makeOperationalLogTracer('main'), 'LedgerIngest.write', 1_000_000n)
    span.end(2_000_000n, Exit.fail(new TypeError(secret)))
    closeOperationalLog()

    const records = readRecords(logDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: SPAN_EVENT, op: 'LedgerIngest.write', code: 'type', durationMs: 1 })
    // The error channel carries user and ledger data: the `Exit` is never
    // rendered, only the `errorCodeFor` slug.
    const raw = readRaw(logDir)
    expect(raw).not.toContain('gpt-5')
    expect(raw).not.toContain('456.78')
    expect(raw).not.toContain('alice')
    expect(JSON.stringify(records[0])).not.toContain(secret)
  })

  it('never throws before initOperationalLog (mirrors if (!active) return)', async () => {
    closeOperationalLog()
    const tracer = makeOperationalLogTracer('worker')
    expect(() => startSpan(tracer, 'before.init', 0n).end(1_000n, Exit.void)).not.toThrow()
    await expect(
      Effect.runPromise(
        Effect.fn('WorkerArm.dispatch')(function* () {
          return yield* Effect.succeed('done')
        })().pipe(Effect.provide(OperationalLogTracerLayer('worker'))),
      ),
    ).resolves.toBe('done')
  })

  it('stamps the emitting isolate context, so worker spans never read as main', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    startSpan(makeOperationalLogTracer('worker'), 'db-worker.ingest', 0n).end(1_000_000n, Exit.void)
    startSpan(makeOperationalLogTracer('main'), 'main.ingest', 0n).end(1_000_000n, Exit.void)
    closeOperationalLog()
    expect(readRecords(logDir).map(record => record['context'])).toEqual(['worker', 'main'])
  })
})

describe('A7: the layer is what a fiber actually reads', () => {
  it('an Effect.fn span reaches the file through the layer, with a real duration', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const work = Effect.fn('HttpFetch.fetch')(function* () {
      return yield* Effect.succeed('body')
    })
    await expect(Effect.runPromise(work().pipe(Effect.provide(OperationalLogTracerLayer('main'))))).resolves.toBe(
      'body',
    )
    closeOperationalLog()

    const records = readRecords(logDir)
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record).toMatchObject({ context: 'main', event: SPAN_EVENT, op: 'HttpFetch.fetch', kind: 'internal' })
    expect(record).not.toHaveProperty('code')
    expect(typeof record?.['durationMs']).toBe('number')
    expect(record?.['durationMs'] as number).toBeGreaterThanOrEqual(0)
  })

  it('NON-VACUITY: the same program files 0 records on the native tracer and 1 on the operational tracer', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const work = Effect.fn('CommandRunner.start')(function* () {
      return yield* Effect.succeed('started')
    })
    // Control arm: with nothing provided, the `Tracer.Tracer` reference
    // resolves to Effect's own `nativeTracer`, which builds a `NativeSpan` and
    // drops it. That is the bug A7 fixes, so it is asserted, not assumed — if
    // the emission ever silently disappeared from the tracer, both arms would
    // read 0 and this test would fail instead of passing on a vacuous
    // assertion.
    await Effect.runPromise(work())
    expect(readRecords(logDir)).toHaveLength(0)
    await Effect.runPromise(work().pipe(Effect.provide(OperationalLogTracerLayer('main'))))
    expect(readRecords(logDir)).toHaveLength(1)
  })

  it('a nested span files its parent span id and shares the trace id', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const inner = Effect.fn('LedgerQueries.overview')(function* () {
      return yield* Effect.succeed('rows')
    })
    const outer = Effect.fn('CommandRunner.run')(function* () {
      return yield* inner()
    })
    await Effect.runPromise(outer().pipe(Effect.provide(OperationalLogTracerLayer('main'))))
    closeOperationalLog()

    const byName = new Map(readRecords(logDir).map(record => [record['op'], record]))
    expect([...byName.keys()].sort()).toEqual(['CommandRunner.run', 'LedgerQueries.overview'])
    const parent = byName.get('CommandRunner.run')
    const child = byName.get('LedgerQueries.overview')
    expect(child?.['parentSpanId']).toBe(parent?.['spanId'])
    expect(child?.['traceId']).toBe(parent?.['traceId'])
  })
})

describe('A7: span attributes ride the sanitizer, not the seam', () => {
  it('drops a non-allowlisted attribute and refuses to let one overwrite the record', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    const tracer = makeOperationalLogTracer('main')
    // `Effect.fn(name, { attributes })` attributes are Effect-internal, never
    // vetted ledger facts — same contract as an `Effect.log` annotation. One of
    // them even tries to speak for the record it rides on.
    const span = startSpan(tracer, 'Scan.apply', 0n, {
      op: 'spoofed',
      prompt: 'secret prompt body',
      file: 'C:\\Users\\alice\\sessions.json',
    })
    span.end(1_000_000n, Exit.void)
    closeOperationalLog()

    const records = readRecords(logDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ op: 'Scan.apply' })
    expect(records[0]).not.toHaveProperty('prompt')
    // `file` is allowlisted, so it survives reduced to a basename — the same
    // rewrite every other `file` record gets.
    expect(records[0]).toMatchObject({ file: 'sessions.json' })
    expect(readRaw(logDir)).not.toContain('alice')
  })
})
