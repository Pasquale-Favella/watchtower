import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dismissSkill, setModelPrice } from '../src/main/application/ledger-config-commands.js'
import { ledgerConfigRequest } from '../src/main/db-worker/config-dispatch.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { workerProtocolError } from '../src/main/db-worker/protocol-errors.js'
import { LedgerConfig } from '../src/main/store/ledger-ports.js'
import { openWorkerOwner } from './fixtures/worker-owner.js'

function fakeConfig(overrides: Partial<LedgerConfig['Service']> = {}): LedgerConfig['Service'] {
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
    getRefreshCadence: () => Effect.succeed('manual'),
    setRefreshCadence: () => Effect.void,
    getLedgerMcpStartupMode: () => Effect.succeed('on-demand'),
    setLedgerMcpStartupMode: () => Effect.void,
    getSkillDismissals: () => Effect.succeed([]),
    dismissSkill: () => Effect.void,
    ...overrides,
  })
}

async function withWorker(
  run: (context: DbWorkerContext, owner: ReturnType<typeof openWorkerOwner>, events: DbWorkerEvent[]) => Promise<void>,
  config?: LedgerConfig['Service'],
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-config-commands-'))
  const dbPath = join(directory, 'ledger.db')
  const owner = openWorkerOwner(dbPath, undefined, config ? Layer.succeed(LedgerConfig, config) : undefined)
  const events: DbWorkerEvent[] = []
  const context = new DbWorkerContext(
    { dbPath, dataDir: directory, cacheDir: join(directory, 'cache') },
    event => events.push(event),
    owner,
  )
  try {
    await run(context, owner, events)
  } finally {
    await context.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

afterEach(() => vi.restoreAllMocks())

describe('worker configuration commands use the owned ports', () => {
  it('selects a lazy command and broadcasts only after the configured write', async () => {
    const steps: string[] = []
    const write = vi.fn((model: string, aliasOf: string) =>
      Effect.sync(() => {
        steps.push(`write:${model}:${aliasOf}`)
      }),
    )
    const request = ledgerConfigRequest(
      'models:addAlias',
      [' model ', ' target '],
      Effect.sync(() => {
        steps.push('config:changed')
      }),
    )
    expect(write).not.toHaveBeenCalled()
    expect(steps).toEqual([])
    if (!request) throw new Error('Alias command was not selected')

    const result = await Effect.runPromise(
      request.pipe(Effect.provideService(LedgerConfig, fakeConfig({ setModelAlias: write }))),
    )
    expect(result).toEqual({ ok: true })
    expect(steps).toEqual(['write:model:target', 'config:changed'])
    expect(write).toHaveBeenCalledOnce()
  })

  it('leaves scan, cadence, settings and unknown operations to worker supervision', () => {
    const changed = vi.fn()
    const notification = Effect.sync(changed)
    for (const op of ['scan:start', 'cadence:set', 'settings:clear', 'unknown']) {
      expect(ledgerConfigRequest(op, [], notification)).toBeUndefined()
    }
    expect(changed).not.toHaveBeenCalled()
  })

  it('persists configuration through the native root without using facade methods', async () => {
    await withWorker(async (context, owner, events) => {
      const facadeMethods = [
        'getRefreshCadence',
        'setRefreshCadence',
        'getModelAliases',
        'setModelAlias',
        'removeModelAlias',
        'getPriceOverrides',
        'setPriceOverride',
        'removePriceOverride',
        'getLedgerMcpStartupMode',
        'setLedgerMcpStartupMode',
        'dismissSkill',
      ] as const
      const spies = facadeMethods.map(method =>
        vi.spyOn(owner.ledger, method).mockImplementation(() => {
          throw new Error(`facade ${method} must not be used`)
        }),
      )

      expect(await context.dispatch('cadence:set', ['manual'])).toBe('manual')
      expect(await context.dispatch('cadence:get', [])).toBe('manual')
      expect(await context.dispatch('cadence:set', ['invalid'])).toBe('1m')
      expect(await context.dispatch('ledger-mcp:startup:set', ['at-launch'])).toBe('at-launch')
      expect(await context.dispatch('ledger-mcp:startup:get', [])).toBe('at-launch')
      expect(await context.dispatch('ledger-mcp:startup:set', [null])).toBe('on-demand')
      expect(await context.dispatch('models:addAlias', ['  local-model  ', '  target  '])).toEqual({ ok: true })
      expect(await context.dispatch('models:getAliases', [])).toEqual([{ model: 'local-model', aliasOf: 'target' }])
      expect(await context.dispatch('models:setPrice', ['  local-model  ', 0, 2])).toEqual({ ok: true })
      expect(await context.dispatch('models:getPriceOverrides', [])).toEqual([
        { model: 'local-model', inputPricePerMillion: 0, outputPricePerMillion: 2 },
      ])
      expect(await context.dispatch('models:removeAlias', [' local-model '])).toEqual({ ok: true })
      expect(await context.dispatch('models:removePriceOverride', [' local-model '])).toEqual({ ok: true })
      expect(await context.dispatch('models:getAliases', [])).toEqual([])
      expect(await context.dispatch('models:getPriceOverrides', [])).toEqual([])
      expect(
        await context.dispatch('skills:dismiss', [{ source: 'bash', name: 'git status', reason: 'routine' }]),
      ).toEqual({ ok: true })
      const dismissals = await owner.runtime.runPromise(
        Effect.flatMap(LedgerConfig, config => config.getSkillDismissals()),
      )
      expect(dismissals).toEqual([
        {
          source: 'bash',
          name: 'git status',
          reason: 'routine',
          created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        },
      ])
      expect(events.filter(event => event.event === 'config:changed')).toHaveLength(4)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })

  const invalidInputs = [
    { op: 'models:addAlias', args: [' ', 'target'], message: 'model and alias target must be non-empty strings' },
    { op: 'models:addAlias', args: ['model', 4], message: 'model and alias target must be non-empty strings' },
    { op: 'models:removeAlias', args: [null], message: 'model must be a non-empty string' },
    { op: 'models:removePriceOverride', args: ['\t'], message: 'model must be a non-empty string' },
    { op: 'models:setPrice', args: [false, -1, NaN], message: 'model must be a non-empty string' },
    ...[-1, NaN, Infinity, -Infinity, '2', null].flatMap(price => [
      { op: 'models:setPrice', args: ['model', price, 0], message: 'prices must be non-negative numbers' },
      { op: 'models:setPrice', args: ['model', 0, price], message: 'prices must be non-negative numbers' },
    ]),
  ]

  it.each(invalidInputs)('rejects $op $args before writing or broadcasting', async ({ op, args, message }) => {
    const write = vi.fn(() => Effect.void)
    await withWorker(
      async (context, _owner, events) => {
        const error = await context.dispatch(op, args).catch(error => error)
        expect(error).toMatchObject({ _tag: 'LedgerConfigValidationError', message })
        expect(workerProtocolError(error)).toBe(message)
        expect(write).not.toHaveBeenCalled()
        expect(events.filter(event => event.event === 'config:changed')).toEqual([])
      },
      fakeConfig({
        setModelAlias: write,
        removeModelAlias: write,
        setPriceOverride: write,
        removePriceOverride: write,
      }),
    )
  })

  it('broadcasts only after a substituted write finishes', async () => {
    const started = Deferred.makeUnsafe<undefined>()
    const finish = Deferred.makeUnsafe<undefined>()
    const config = fakeConfig({
      setModelAlias: (model, aliasOf) =>
        Effect.gen(function* () {
          expect([model, aliasOf]).toEqual(['model', 'target'])
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)
        }),
    })
    await withWorker(async (context, _owner, events) => {
      const pending = context.dispatch('models:addAlias', [' model ', ' target '])
      await Effect.runPromise(Deferred.await(started))
      expect(events.filter(event => event.event === 'config:changed')).toEqual([])
      await Effect.runPromise(Deferred.succeed(finish, undefined))
      expect(await pending).toEqual({ ok: true })
      expect(events.filter(event => event.event === 'config:changed')).toEqual([{ event: 'config:changed' }])
    }, config)
  })

  it('writes cadence before the supervisor read and final response read', async () => {
    const order: string[] = []
    const getCadence = vi.fn(() =>
      Effect.sync(() => {
        order.push('read')
        return 'manual'
      }),
    )
    const setCadence = vi.fn((value: string) =>
      Effect.sync(() => {
        order.push(`write:${value}`)
      }),
    )
    await withWorker(
      async (context, owner) => {
        await owner.runtime.runPromise(Effect.void)
        order.length = 0
        expect(await context.dispatch('cadence:set', ['manual'])).toBe('manual')
        expect(order).toEqual(['write:manual', 'read', 'read'])
      },
      fakeConfig({ getRefreshCadence: getCadence, setRefreshCadence: setCadence }),
    )
  })

  const writes = [
    { op: 'models:addAlias', args: ['model', 'target'], method: 'setModelAlias' },
    { op: 'models:removeAlias', args: ['model'], method: 'removeModelAlias' },
    { op: 'models:setPrice', args: ['model', 0, 0], method: 'setPriceOverride' },
    { op: 'models:removePriceOverride', args: ['model'], method: 'removePriceOverride' },
    { op: 'skills:dismiss', args: [{ source: 'tool', name: 'Read', reason: 'routine' }], method: 'dismissSkill' },
    { op: 'cadence:set', args: ['manual'], method: 'setRefreshCadence' },
    { op: 'ledger-mcp:startup:set', args: ['at-launch'], method: 'setLedgerMcpStartupMode' },
  ] as const

  it.each(writes)('$op preserves typed SQL failures and emits no successful change', async ({ op, args, method }) => {
    const error = new SqlError.SqlError({ reason: new SqlError.ConnectionError({ cause: new Error('private path') }) })
    await withWorker(
      async (context, _owner, events) => {
        await expect(context.dispatch(op, [...args])).rejects.toBe(error)
        expect(events.filter(event => event.event === 'config:changed')).toEqual([])
      },
      fakeConfig({ [method]: () => Effect.fail(error) }),
    )
  })

  it.each(['models:getAliases', 'models:getPriceOverrides'])('%s preserves row decode failures', async op => {
    const failure = Schema.decodeUnknownEffect(Schema.Never)(null)
    await withWorker(
      async context => {
        await expect(context.dispatch(op, [])).rejects.toMatchObject({ _tag: 'SchemaError' })
      },
      fakeConfig({ getModelAliases: () => failure, getPriceOverrides: () => failure }),
    )
  })

  it('keeps command defects and interruption in their failure channels', async () => {
    await withWorker(
      async (context, owner, events) => {
        await expect(context.dispatch('models:setPrice', ['model', 0, 0])).rejects.toThrow('command defect')
        const config = fakeConfig({ setPriceOverride: () => Effect.never })
        const fiber = owner.runtime.runFork(
          setModelPrice('model', 0, 0).pipe(Effect.provideService(LedgerConfig, config)),
        )
        await owner.runtime.runPromise(Fiber.interrupt(fiber))
        const exit = await owner.runtime.runPromise(Fiber.await(fiber))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(events.filter(event => event.event === 'config:changed')).toEqual([])
      },
      fakeConfig({ setPriceOverride: () => Effect.die(new Error('command defect')) }),
    )
  })

  it('captures dismissal time from the Effect Clock', async () => {
    const write = vi.fn(() => Effect.void)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-06T12:34:56.789Z')))
        yield* dismissSkill({ source: 'skill', name: 'example', reason: 'routine' })
      }).pipe(
        Effect.provideService(LedgerConfig, fakeConfig({ dismissSkill: write })),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(write).toHaveBeenCalledWith('skill', 'example', 'routine', '2026-10-06T12:34:56.789Z')
  })
})
