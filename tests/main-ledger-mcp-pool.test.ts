import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import * as Effect from 'effect/Effect'
import { afterEach, expect, it, vi } from 'vitest'

import { LedgerMcpPool } from '../src/main/agents/ledger-mcp/pool.js'
import { type MainRuntime, makeMainRuntime } from '../src/main/main-runtime.js'

const fixtures: Array<{ runtime: MainRuntime; close: () => void }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close()
    await fixture.runtime.dispose()
  }
})

it('the main graph owns a pooled sidecar boot before READY and awaits actual close', async () => {
  const child = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  Object.assign(child, { stdout, stderr, kill })
  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    stdout.end()
    stderr.end()
    child.emit('close', 0, null)
  }
  const spawnChild = vi.fn(() => child as ChildProcess) as unknown as typeof spawn
  const runtime = makeMainRuntime(
    { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
    { detect: async () => [], sidecar: { spawnChild } },
  )
  fixtures.push({ runtime, close })
  const pending = runtime
    .runPromise(
      Effect.flatMap(LedgerMcpPool, pool =>
        pool.connection({ execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }),
      ),
    )
    .then(
      () => undefined,
      () => undefined,
    )
  await vi.waitFor(() => expect(stdout.listenerCount('data')).toBeGreaterThan(0))
  let disposed = false
  const disposal = runtime.dispose().then(() => {
    disposed = true
  })
  await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce())
  expect(disposed).toBe(false)
  close()
  await disposal
  await pending
  expect(spawnChild).toHaveBeenCalledOnce()
  expect(kill).toHaveBeenCalledOnce()
  expect(child.listenerCount('close')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
})
