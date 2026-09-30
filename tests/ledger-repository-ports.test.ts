/**
 * ADR 0032 §A3 / plan F12 — the ledger's three focused ports.
 *
 * The claim under test is NOT "the SQL still works": `tests/ledger.test.ts`
 * already locks that through the facade, unchanged. The claim is that the one
 * 23-member `LedgerRepository` became THREE independently providable,
 * independently fakeable services, and that the split did not cost a second
 * implementation. Three things a type annotation alone cannot show:
 *
 *  1. **Isolation, provably.** A graph containing ONLY a `LedgerQueries` fake
 *     answers the four reads; reaching `LedgerIngest` or `LedgerConfig` from that
 *     SAME graph fails. The failure is the half that matters — "the other ports
 *     happen to be absent" is evidence only if their absence is observable, and
 *     `tests/` is in neither tsconfig, so a `Layer.Layer<LedgerQueries>`
 *     annotation here would prove nothing at all. Repeated for all three tags.
 *  2. **One implementation, three tags.** All three LIVE ports, taken from one
 *     real `LedgerStore` connection, read and write ONE ledger: a row ported
 *     through `LedgerIngest.portIn` is visible to `LedgerQueries.getCalls` and
 *     writable by `LedgerConfig` in the same program. Triplicated SQL would mean
 *     triplicated connections and this could not hold.
 *  3. **The rows are still Zod-validated.** Every read still goes through
 *     `z.array(rowSchema).parse` — the wire-boundary guarantee the split must not
 *     weaken — proven by asserting the Zod-parsed shape (numeric tokens, parsed
 *     JSON arrays) rather than raw driver rows.
 *
 * No `process.env` is mutated anywhere in this file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'

import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-repository.js'
import type { PortInput } from '../src/main/store/port.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const tempDirs: string[] = []
const open: Array<() => void> = []

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-ledger-ports-'))
  tempDirs.push(dir)
  const store = new LedgerStore(join(dir, 'ledger.db'))
  open.push(() => {
    try {
      store.close()
    } catch {
      /* already closed */
    }
  })
  return store
}

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-ports',
  filePath: FIXTURE_SOURCE_PATH,
  repoUrl: 'https://github.com/acme/ports-project',
}

function newPortInput(): PortInput {
  return { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() } as unknown as PortInput
}

afterEach(() => {
  for (const close of open.splice(0)) close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Runs `program` against `layer` and reports whether it SUCCEEDED — the
 * observability half of the isolation proof. A missing port must fail loudly,
 * never answer with `undefined`; anything short of a failure would make the
 * sibling "is absent" claims unfalsifiable.
 */
function reachable<A, R, L>(program: Effect.Effect<A, unknown, R>, layer: Layer.Layer<L>): Promise<boolean> {
  // This deliberate dynamic provision asks Effect to look up a port omitted by
  // the supplied fake. The static `Effect.provide` overload rejects that graph,
  // so invoke the same runtime entry through Reflect.apply at this test seam.
  const provided = Reflect.apply(Effect.provide, undefined, [program, layer]) as Effect.Effect<A, unknown, never>
  const exited = Effect.exit(provided).pipe(Effect.map(exit => Exit.isSuccess(exit)))
  return Reflect.apply(Effect.runPromise, undefined, [exited]) as Promise<boolean>
}

// ── 1. Independence ────────────────────────────────────────────────────────

describe('each port is providable in isolation, with the other two absent', () => {
  it('a LedgerQueries fake answers all four reads, and ingest + config are unreachable from it', async () => {
    const calls: string[] = []
    const fakeQueries = Layer.succeed(
      LedgerQueries,
      LedgerQueries.of({
        getSources: () => Effect.sync(() => (calls.push('getSources'), [])),
        getSessions: () => Effect.sync(() => (calls.push('getSessions'), [])),
        getTurns: () => Effect.sync(() => (calls.push('getTurns'), [])),
        getCalls: () => Effect.sync(() => (calls.push('getCalls'), [])),
        getCallFacts: () => Effect.sync(() => (calls.push('getCallFacts'), [])),
      }),
    )

    await expect(
      Effect.runPromise(
        Effect.flatMap(LedgerQueries, queries =>
          Effect.all([
            queries.getSources(),
            queries.getSessions(),
            queries.getTurns(),
            queries.getCalls(),
            queries.getCallFacts(),
          ]),
        ).pipe(Effect.provide(fakeQueries)),
      ),
    ).resolves.toEqual([[], [], [], [], []])
    expect(calls).toEqual(['getSources', 'getSessions', 'getTurns', 'getCalls', 'getCallFacts'])

    // Absence is OBSERVED. Pre-split there was one tag, so "the other two are
    // missing" was not a state this could express at all.
    await expect(
      reachable(
        Effect.flatMap(LedgerIngest, ingest => ingest.clear()),
        fakeQueries,
      ),
    ).resolves.toBe(false)
    await expect(
      reachable(
        Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()),
        fakeQueries,
      ),
    ).resolves.toBe(false)
  })

  it('a LedgerIngest fake answers portIn / deleteSource / clear, and queries + config are unreachable', async () => {
    const seen: string[] = []
    const fakeIngest = Layer.succeed(
      LedgerIngest,
      LedgerIngest.of({
        portIn: input =>
          Effect.sync(() => {
            seen.push(`portIn:${input.filePath}`)
            return { verdict: 'new', sourceId: 1, inserted: { sessions: 0, turns: 0, calls: 0 } }
          }),
        deleteSource: (provider, envFingerprint, filePath) =>
          Effect.sync(() => void seen.push(`deleteSource:${provider}:${envFingerprint}:${filePath}`)),
        clear: () => Effect.sync(() => void seen.push('clear')),
      }),
    )

    await expect(
      Effect.runPromise(
        Effect.flatMap(LedgerIngest, ingest =>
          Effect.gen(function* () {
            yield* ingest.portIn(newPortInput())
            yield* ingest.deleteSource('opencode', 'env-ports', 'a.jsonl')
            yield* ingest.clear()
          }),
        ).pipe(Effect.provide(fakeIngest)),
      ),
    ).resolves.toBeUndefined()
    expect(seen).toEqual([`portIn:${FIXTURE_SOURCE_PATH}`, 'deleteSource:opencode:env-ports:a.jsonl', 'clear'])

    await expect(
      reachable(
        Effect.flatMap(LedgerQueries, queries => queries.getCalls()),
        fakeIngest,
      ),
    ).resolves.toBe(false)
    await expect(
      reachable(
        Effect.flatMap(LedgerConfig, config => config.getDisplayCurrency()),
        fakeIngest,
      ),
    ).resolves.toBe(false)
  })

  it('a LedgerConfig fake answers the settings members, and ingest + queries are unreachable', async () => {
    const fakeConfig = Layer.succeed(
      LedgerConfig,
      LedgerConfig.of({
        getModelAliases: () => Effect.succeed([{ model: 'a', aliasOf: 'b' }]),
        setModelAlias: () => Effect.void,
        removeModelAlias: () => Effect.void,
        getPriceOverrides: () => Effect.succeed([]),
        setPriceOverride: () => Effect.void,
        removePriceOverride: () => Effect.void,
        getCurrencyRate: () => Effect.succeed(null),
        setCurrencyRate: () => Effect.void,
        getDisplayCurrency: () => Effect.succeed('EUR'),
        setDisplayCurrency: () => Effect.void,
        getRefreshCadence: () => Effect.succeed('5m'),
        setRefreshCadence: () => Effect.void,
        getLedgerMcpStartupMode: () => Effect.succeed('on-demand'),
        setLedgerMcpStartupMode: () => Effect.void,
        getSkillDismissals: () => Effect.succeed([]),
        dismissSkill: () => Effect.void,
      }),
    )

    await expect(
      Effect.runPromise(
        Effect.flatMap(LedgerConfig, config =>
          Effect.all([config.getModelAliases(), config.getDisplayCurrency(), config.getRefreshCadence()]),
        ).pipe(Effect.provide(fakeConfig)),
      ),
    ).resolves.toEqual([[{ model: 'a', aliasOf: 'b' }], 'EUR', '5m'])

    await expect(
      reachable(
        Effect.flatMap(LedgerIngest, ingest => ingest.clear()),
        fakeConfig,
      ),
    ).resolves.toBe(false)
    await expect(
      reachable(
        Effect.flatMap(LedgerQueries, queries => queries.getTurns()),
        fakeConfig,
      ),
    ).resolves.toBe(false)
  })
})

// ── 2 & 3. One implementation, three tags, still Zod-validated ─────────────

describe('the three live ports share ONE implementation over the writer connection', () => {
  it('a row ported through LedgerIngest is readable through LedgerQueries and writable by LedgerConfig', async () => {
    const store = makeStore()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        const queries = yield* LedgerQueries
        const config = yield* LedgerConfig

        const ported = yield* ingest.portIn(newPortInput())
        const calls = yield* queries.getCalls()
        const sources = yield* queries.getSources()
        yield* config.setModelAlias('aliased-model', 'real-model')
        const aliases = yield* config.getModelAliases()

        return {
          insertedCalls: ported.inserted.calls,
          callCount: calls.length,
          inputTokens: calls[0]?.inputTokens,
          tools: calls[0]?.tools,
          sourceCount: sources.length,
          aliases,
        }
      }).pipe(Effect.provide(store.portsLayer)),
    )

    expect(result.insertedCalls).toBeGreaterThan(0)
    // ONE ledger, THREE tags, one program: `ported` from LedgerIngest, `calls`
    // from LedgerQueries, `aliases` from LedgerConfig. A duplicated SQL
    // implementation per port would need its own connection and this could not
    // hold.
    expect(result.callCount).toBeGreaterThan(0)
    expect(result.sourceCount).toBe(1)

    // Zod at the row boundary is unchanged: tokens arrive as numbers (not driver
    // text) and JSON columns as arrays (not raw JSON strings).
    expect(typeof result.inputTokens).toBe('number')
    expect(Array.isArray(result.tools)).toBe(true)
    expect(result.aliases).toEqual([{ model: 'aliased-model', aliasOf: 'real-model' }])

    // And the facade sees the same rows: its delegators were RE-POINTED at the
    // ports, not reimplemented.
    expect(store.getCalls().length).toBe(result.callCount)
    expect(store.getModelAliases()).toEqual(result.aliases)
  })

  it('deleteSource removes one source; clear empties the fact tables and keeps the config tables', async () => {
    const store = makeStore()
    store.setModelAlias('keep-me', 'real-model')
    store.setRefreshCadence('5m')

    const deleted = await Effect.runPromise(
      Effect.flatMap(LedgerIngest, ingest => ingest.deleteSource('opencode', 'env-ports', FIXTURE_SOURCE_PATH)).pipe(
        Effect.provide(store.portsLayer),
      ),
    )
    expect(deleted).toBeUndefined()
    // A source that was never ported is a no-op, not an error — unchanged.
    expect(store.getSources()).toEqual([])

    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        const queries = yield* LedgerQueries
        yield* ingest.portIn(newPortInput())
        return { before: (yield* queries.getCalls()).length }
      }).pipe(Effect.provide(store.portsLayer)),
    )
    expect(after.before).toBeGreaterThan(0)

    const cleared = await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        const queries = yield* LedgerQueries
        const config = yield* LedgerConfig
        yield* ingest.clear()
        return {
          sources: yield* queries.getSources(),
          calls: yield* queries.getCalls(),
          aliases: yield* config.getModelAliases(),
          cadence: yield* config.getRefreshCadence(),
        }
      }).pipe(Effect.provide(store.portsLayer)),
    )

    expect(cleared.sources).toEqual([])
    expect(cleared.calls).toEqual([])
    expect(cleared.aliases).toEqual([{ model: 'keep-me', aliasOf: 'real-model' }])
    expect(cleared.cadence).toBe('5m')
  })
})
