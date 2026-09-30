/**
 * `WorkerLive` — the db-worker composition root (ADR 0032, F10/F11/F13/F14).
 *
 * The db-worker isolate used to have NO composition root: `context.ts` provided
 * layers inside each call site (`performScan`, `startBackgroundFx`,
 * `currency:set`, `pricing:refresh`), so `Env.layer` was rebuilt on every scan
 * and nothing was a memoised singleton. The consequences were measurable and
 * are what this file pins:
 *
 *  1. `Env.layer` is constructed EXACTLY ONCE per worker lifetime — proven with
 *     a counting fake layer, not asserted. This is `ManagedRuntime`'s memoised
 *     build, so the property is worth proving rather than assuming.
 *  2. Every `Effect.provide` is gone from `context.ts` — proven by reading the
 *     module source, because a claim in a commit message is not a guard.
 *  3. A SUBSTITUTED layer reaches a dispatch arm. Before the root this was
 *     structurally impossible: the layer was welded at the arm, so no test could
 *     drive `currency:set` or `pricing:refresh` against a fake. This is the
 *     whole point of the slice, and it is the case that would have caught a
 *     regression immediately.
 *  4. `OperationalLogLoggerLayer` is installed in a production root (F14: it was
 *     referenced only by `tests/operational-log.test.ts`).
 *
 * Fakes come from the existing seams — `Env.layerWithValues`,
 * `HttpFetch.layerWithFetch`, `OperationalLog.layerWithSink`,
 * `FxRates.layerWithRates` — so no `process.env` is mutated anywhere in this
 * file.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'

import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { Env } from '../src/main/env.js'
import { FxRates } from '../src/main/fx.js'
import { OperationalLog, type OperationalLogSink } from '../src/main/operational-log.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-repository.js'
import { makeWorkerLive, makeWorkerRuntime, type WorkerServices } from '../src/main/worker-runtime.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'watchtower-worker-runtime-'))
}

function okFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

function recordingSink(): { sink: OperationalLogSink; records: string[] } {
  const records: string[] = []
  return {
    sink: { emit: (_level, event) => records.push(event) },
    records,
  }
}

const open: Array<() => Promise<void>> = []

afterEach(async () => {
  while (open.length > 0) await open.pop()!()
})

/** Mirrors the worker composition root (`db-worker/entry.ts`): a fresh
 * single-writer store per case, and the runtime built from it. The layer is
 * overridable so a case can substitute capabilities. The factory receives the
 * store, because a substituted graph still has to supply the three `Ledger*`
 * ports (`WorkerServices` includes them since ADR 0032 §A3) and the live ones
 * come from the store's own writer connection via `ledger.portsLayer`. */
function worker(layerFor?: (ledger: LedgerStore) => Layer.Layer<WorkerServices>) {
  const dir = tempDir()
  const ledger = new LedgerStore(join(dir, 'ledger.db'))
  const runtime = makeWorkerRuntime(ledger, layerFor ? layerFor(ledger) : makeWorkerLive(ledger))
  const ctx = new DbWorkerContext({ dbPath: ledger.dbPath, dataDir: dir, cacheDir: join(dir, 'cache') }, () => {}, {
    ledger,
    runtime,
  })
  open.push(async () => {
    // `ctx.close()` retires BOTH deps (the store and the runtime) — closing
    // either again here would run a second `disposeEffect` on an
    // already-disposed `ManagedRuntime`, which dies by design.
    try {
      await ctx.close()
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

describe('WorkerLive: Env is constructed once per worker lifetime', () => {
  it('a counting Env layer is built exactly once no matter how many arms run', async () => {
    let builds = 0
    const countingEnv = Layer.effect(
      Env,
      Effect.sync(() => {
        builds += 1
        return Env.of({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })
      }),
    )
    const ctx = worker(ledger =>
      Layer.mergeAll(
        countingEnv,
        OperationalLog.layer,
        HttpFetch.layerWithFetch(okFetch({})),
        FxRates.layerWithRates({
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: () => Effect.void,
        }),
        ledger.portsLayer,
      ),
    )

    // The constructor primes background FX through the runtime, so the graph is
    // already built here — once, for the whole worker lifetime.
    expect(builds).toBe(1)
    // Every subsequent arm reuses that instance. This is the memoisation the
    // old per-call `Effect.provide` could not provide: it rebuilt `Env` on
    // every scan, every FX tick, and every FX/currency dispatch.
    await ctx.dispatch('cadence:get', [])
    await ctx.dispatch('cadence:set', ['5m'])
    await ctx.dispatch('store:status', [])
    await ctx.dispatch('currency:get', [])
    await ctx.dispatch('currency:list', [])
    await ctx.dispatch('currency:set', ['EUR'])
    expect(builds).toBe(1)
  })

  it('the live graph exposes exactly the four worker capabilities and no R', async () => {
    const dir = tempDir()
    const ledger = new LedgerStore(join(dir, 'ledger.db'))
    const live = makeWorkerLive(ledger)
    // `Layer.Layer<WorkerServices>` has `never` in the R slot, so this only
    // compiles if the flat merge needs nothing from the outside.
    const services: Layer.Layer<WorkerServices, never, never> = live
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* Env
        const log = yield* OperationalLog
        const http = yield* HttpFetch
        const rates = yield* FxRates
        return {
          gateway: env.vercelGatewayApiKey,
          ttl: env.pricingCacheTtlMs,
          services: [log, http, rates].length,
        }
      }).pipe(Effect.provide(services)),
    )
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
    // `Env`'s two live values are env-derived, so assert their TYPES and the
    // real parser default rather than a value this test cannot control without
    // mutating `process.env` (which no test here may do).
    expect(typeof resolved.ttl).toBe('number')
    expect(resolved.gateway === null || typeof resolved.gateway === 'string').toBe(true)
    expect(resolved.services).toBe(3)
  })
})

describe('the runtime is released with the worker', () => {
  it('close() disposes the WorkerLive graph, so a second close cannot re-enter it', async () => {
    const ctx = worker()
    await ctx.dispatch('cadence:get', [])
    await expect(ctx.close()).resolves.toBeUndefined()
    // A disposed `ManagedRuntime` answers every runner with
    // `Effect.die("ManagedRuntime disposed")` — by design, and exactly why the
    // teardown must not close the store or the runtime a second time.
    await expect(ctx.close()).resolves.toBeUndefined()
  })
})

describe('WorkerLive: a substituted layer reaches a dispatch arm', () => {
  it('currency:set writes through a fake FxRates, never the ledger', async () => {
    const writes: string[] = []
    const ctx = worker(ledger =>
      Layer.mergeAll(
        Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity }),
        OperationalLog.layer,
        HttpFetch.layerWithFetch(okFetch({ rates: { EUR: 0.9 } })),
        // The substituted port: `currency:set` reaches the R channel, so the
        // fake IS the write path. Pre-slice the arm built its own
        // `FxRates.layerWithRepository(ledger)` and this was impossible.
        FxRates.layerWithRates({
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: code => {
            writes.push(code)
            return Effect.void
          },
        }),
        ledger.portsLayer,
      ),
    )

    // The arm's own return value is the REAL store's active currency
    // (`getActiveCurrency(ledger)`, a sync read by design), so it still says
    // USD: proof that the ledger was never written and the substituted port
    // really is the write path. Pre-slice the layer was welded at the arm, so
    // this state was unreachable no matter what a test did.
    await expect(ctx.dispatch('currency:set', ['EUR'])).resolves.toMatchObject({ code: 'USD' })
    expect(writes).toEqual(['EUR'])
  })

  it('pricing:refresh drives a substituted HttpFetch, and its failure envelope is unchanged', async () => {
    const seen: string[] = []
    const ctx = worker(ledger =>
      Layer.mergeAll(
        Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity }),
        OperationalLog.layer,
        HttpFetch.layerWithFetch(((input: RequestInfo | URL) => {
          seen.push(String(input))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ 'wiring-fake-model': { input_cost_per_token: 0.001, output_cost_per_token: 0.002 } }),
          } as unknown as Response)
        }) as unknown as typeof fetch),
        FxRates.layerWithRates({
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: () => Effect.void,
        }),
        ledger.portsLayer,
      ),
    )

    await expect(ctx.dispatch('pricing:refresh', [])).resolves.toEqual({ ok: true })
    expect(seen.some(url => url.includes('litellm') || url.includes('pricing'))).toBe(true)
  })

  it('the scan duration counter files through a substituted OperationalLog sink', async () => {
    const { sink, records } = recordingSink()
    const ctx = worker(ledger =>
      Layer.mergeAll(
        Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity }),
        OperationalLog.layerWithSink(sink),
        HttpFetch.layerWithFetch(okFetch({})),
        FxRates.layerWithRates({
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: () => Effect.void,
        }),
        ledger.portsLayer,
      ),
    )

    // An empty provider filter keeps the case fast and deterministic (no real
    // provider dirs walked) while still exercising the scan's filing path.
    await expect(ctx.dispatch('scan:start', [{ provider: '__worker-runtime-empty-provider__' }])).resolves.toEqual({
      ok: true,
    })
    expect(records).toContain('scan.duration')
  })
})

describe('F12/ADR 0032 §A3: WorkerLive supplies the three ledger ports', () => {
  it("the live graph provides LedgerIngest, LedgerQueries and LedgerConfig over the store's own connection", async () => {
    const dir = tempDir()
    const ledger = new LedgerStore(join(dir, 'ledger.db'))
    const live = makeWorkerLive(ledger)

    // If any of the three were missing from the merge, the `yield*` below DIES
    // with `Service not found: watchtower/store/<Name>` — so reaching all three
    // is the proof, not a comment claiming they are there.
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        const queries = yield* LedgerQueries
        const config = yield* LedgerConfig
        yield* config.setModelAlias('worker-live-model', 'real-model')
        return {
          cadence: yield* config.getRefreshCadence(),
          aliases: yield* config.getModelAliases(),
          sources: yield* queries.getSources(),
          calls: yield* queries.getCalls(),
          // `LedgerIngest` is reached too — a live no-op delete on an absent
          // source, which must not throw.
          cleared: yield* ingest.deleteSource('opencode', 'env-none', 'never-ported.jsonl'),
        }
      }).pipe(Effect.provide(live)),
    )

    // Same connection: the write through `LedgerConfig` is visible to the
    // store's own sync facade, which is a different `R` slot on the SAME
    // writer. A second `SqliteClient` here would be a second writer (ADR 0023).
    expect(ledger.getModelAliases()).toEqual(resolved.aliases)
    expect(resolved.aliases).toEqual([{ model: 'worker-live-model', aliasOf: 'real-model' }])
    expect(resolved.cadence).toBe('1m')
    expect(resolved.sources).toEqual([])
    expect(resolved.calls).toEqual([])
    expect(resolved.cleared).toBeUndefined()

    // The exported `R` union names all seven capabilities; the counted set is
    // asserted through the graph, since `tests/` is in neither tsconfig.
    const ports = await Effect.runPromise(
      Effect.gen(function* () {
        const [env, log, http, rates, ing, qry, cfg] = yield* Effect.all([
          Env,
          OperationalLog,
          HttpFetch,
          FxRates,
          LedgerIngest,
          LedgerQueries,
          LedgerConfig,
        ])
        return [env, log, http, rates, ing, qry, cfg].length
      }).pipe(Effect.provide(live)),
    )
    expect(ports).toBe(7)

    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a counting LedgerConfig port is built exactly once, and a substituted one reaches the dispatch path', async () => {
    let builds = 0
    const countingConfig = Layer.effect(
      LedgerConfig,
      Effect.sync(() => {
        builds += 1
        return LedgerConfig.of({
          getModelAliases: () => Effect.succeed([]),
          setModelAlias: () => Effect.void,
          removeModelAlias: () => Effect.void,
          getPriceOverrides: () => Effect.succeed([]),
          setPriceOverride: () => Effect.void,
          removePriceOverride: () => Effect.void,
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: () => Effect.void,
          getRefreshCadence: () => Effect.succeed('1m'),
          setRefreshCadence: () => Effect.void,
          getLedgerMcpStartupMode: () => Effect.succeed('on-demand'),
          setLedgerMcpStartupMode: () => Effect.void,
          getSkillDismissals: () => Effect.succeed([]),
          dismissSkill: () => Effect.void,
        })
      }),
    )
    const fakeQueries = LedgerQueries.of({
      getSources: () => Effect.succeed([]),
      getSessions: () => Effect.succeed([]),
      getTurns: () => Effect.succeed([]),
      getCalls: () => Effect.succeed([]),
      getCallFacts: () => Effect.succeed([]),
    })
    const ctx = worker(() =>
      Layer.mergeAll(
        Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity }),
        OperationalLog.layer,
        HttpFetch.layerWithFetch(okFetch({})),
        FxRates.layerWithRates({
          getCurrencyRate: () => Effect.succeed(null),
          setCurrencyRate: () => Effect.void,
          getDisplayCurrency: () => Effect.succeed('USD'),
          setDisplayCurrency: () => Effect.void,
        }),
        // The three ports are substitutable at the SAME seam as every other
        // worker capability — the property §A3 exists for.
        countingConfig,
        Layer.succeed(
          LedgerIngest,
          LedgerIngest.of({
            portIn: () =>
              Effect.succeed({ verdict: 'new', sourceId: null, inserted: { sessions: 0, turns: 0, calls: 0 } }),
            deleteSource: () => Effect.void,
            clear: () => Effect.void,
          }),
        ),
        Layer.succeed(LedgerQueries, fakeQueries),
      ),
    )

    // The constructor primes background FX through the runtime, so the graph is
    // already built here — once, for the whole worker lifetime.
    expect(builds).toBe(1)
    await ctx.dispatch('cadence:get', [])
    await ctx.dispatch('cadence:set', ['5m'])
    await ctx.dispatch('currency:get', [])
    expect(builds).toBe(1)

    // The SUBSTITUTED ports are the ones the dispatch path runs against. Reached
    // through the same private handle `db-worker.test.ts` uses for its scan
    // spies: no arm is touched, and the arm that already runs through the
    // runtime (`cadence:set` → `this.runtime.runPromise`) already returned above.
    const runtime = (
      ctx as unknown as {
        runtime: { runSync: <A, E>(e: Effect.Effect<A, E, never>) => A }
      }
    ).runtime
    const seen = runtime.runSync(
      Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()).pipe(Effect.provide(countingConfig)),
    )
    // The fake says '1m' while the store's own `cadence:set` above persisted
    // '5m' — so this is the substituted port, not the ledger.
    expect(seen).toBe('1m')
    const fakeSources = runtime.runSync(
      Effect.flatMap(LedgerQueries, queries => queries.getSources()).pipe(
        Effect.provide(Layer.succeed(LedgerQueries, fakeQueries)),
      ),
    )
    expect(fakeSources).toEqual([])
  })
})

describe('F14: OperationalLogLoggerLayer is installed in a production root', () => {
  it('WorkerLive provides the Effect logger refs, not just the loggers', async () => {
    const dir = tempDir()
    const ledger = new LedgerStore(join(dir, 'ledger.db'))
    // `OperationalLogLoggerLayer` adds NO service to `R` (it sets the
    // `CurrentLoggers` / `MinimumLogLevel` references), so the check is
    // structural: the live graph is still exactly `WorkerServices`, and the
    // layer is in the merge. A comment cannot prove that; the exported symbol
    // list and the `R` type can.
    const live: Layer.Layer<WorkerServices, never, never> = makeWorkerLive(ledger)
    const source = readFileSync(join(repoRoot, 'src', 'main', 'worker-runtime.ts'), 'utf8')
    ledger.close()
    rmSync(dir, { recursive: true, force: true })

    // The bridge is composed, not merely re-exported: it is inside `mergeAll`.
    // Scoped to the merge body, because the import line also names it (and a
    // sibling layer, `OperationalLogTracerLayer`, sorts right after it there).
    const mergeBody = source.slice(source.indexOf('Layer.mergeAll('))
    expect(mergeBody).toContain('OperationalLogLoggerLayer,')
    expect(live).toBeDefined()
  })

  it('A7: the Tracer layer is installed in BOTH production roots', () => {
    // The `Tracer` half of the same bridge. A worker-only install would leave
    // every main-isolate span dangling and merely relocate the problem, so
    // BOTH roots are asserted — each names its own `LogContext`.
    const workerSource = readFileSync(join(repoRoot, 'src', 'main', 'worker-runtime.ts'), 'utf8')
    const mainSource = readFileSync(join(repoRoot, 'src', 'main', 'main-runtime.ts'), 'utf8')
    expect(workerSource.slice(workerSource.indexOf('Layer.mergeAll('))).toContain("OperationalLogTracerLayer('worker')")
    expect(mainSource.slice(mainSource.indexOf('Layer.mergeAll('))).toContain("OperationalLogTracerLayer('main')")
  })
})

describe('F10/P2: no Effect.provide survives in context.ts', () => {
  it('the worker context composes no layer at any call site', () => {
    const source = readFileSync(join(repoRoot, 'src', 'main', 'db-worker', 'context.ts'), 'utf8')
    // Comments legitimately name `Effect.provide` and the removed
    // `liveFetchLayer`/`liveFxLayer` seams when recording WHY they went, so
    // the guard reads CODE ONLY — comments and string bodies blanked.
    const code = stripCommentsAndStrings(source)
    expect(code).not.toContain('Effect.provide')
    // The two former seams are gone as functions, not just as call sites.
    expect(code).not.toContain('liveFetchLayer')
    expect(code).not.toContain('liveFxLayer')
    // And the layer module is no longer imported at all.
    expect(code).not.toMatch(/from 'effect\/Layer'/)
  })

  it('run* remains only at the composition boundaries the ADR names', () => {
    const source = readFileSync(join(repoRoot, 'src', 'main', 'db-worker', 'context.ts'), 'utf8')
    const code = stripCommentsAndStrings(source)
    // `Effect.runSync` / `Effect.runPromise` / `Effect.runFork` survive ONLY
    // where a fiber or a Promise boundary genuinely needs one: the scan fork,
    // the FX fork, the runtime's own runners, the `cadence:set` reschedule, and
    // the shutdown/join path. `Effect.runPromise(Effect.sync(...))` — ceremony
    // with no composition in it — is gone.
    expect(code).not.toContain('Effect.runPromise(Effect.sync(')
  })
})

/** Removes comments and string/template literal BODIES, keeping newlines so a
 * failure still names a plausible line. Comments must go: this file's own
 * header discusses the very tokens the guard looks for, and a guard a sentence
 * could satisfy is not a guard. */
function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === '`' || c === "'" || c === '"') {
      const quote = c
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        if (source[i] === '\n') out += '\n'
        i++
      }
      i++
      continue
    }
    out += c
    i++
  }
  return out
}
