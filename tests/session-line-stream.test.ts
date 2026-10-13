import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Fiber, Result, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  streams: [] as Array<{
    closed: boolean
    once: (event: 'open' | 'close', listener: () => void) => unknown
  }>,
  delayStat: false,
  statCalls: 0,
  failRead: false,
  onStatStarted: undefined as (() => void) | undefined,
  releaseStat: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      if (native.failRead) {
        stream.once('data', () => setImmediate(() => stream.destroy(new Error('injected read failure'))))
      }
      native.streams.push(stream)
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      native.statCalls++
      if (!native.delayStat) return actual.stat(...args)
      native.delayStat = false
      return new Promise<Awaited<ReturnType<typeof actual.stat>>>(resolve => {
        native.releaseStat = () => {
          void actual.stat(...args).then(resolve)
        }
        native.onStatStarted?.()
      })
    },
  }
})

import { writeFile } from 'node:fs/promises'

import { readSessionLinesStream, SessionLineReadError } from '../src/main/pipeline/fs-utils.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  native.streams.length = 0
  native.delayStat = false
  native.statCalls = 0
  native.failRead = false
  native.onStatStarted = undefined
  native.releaseStat = undefined
})

async function setup(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'watchtower-session-line-stream-'))
  return join(root, 'session.jsonl')
}

describe('native session line stream', () => {
  it('propagates an opted-in missing-file failure', async () => {
    const path = await setup()
    const result = await Effect.runPromise(
      Effect.result(Stream.runCollect(readSessionLinesStream(path, undefined, { readFailure: 'fail' }))),
    )
    if (Result.isSuccess(result)) throw new Error('Expected a missing-file failure')
    expect(result.failure).toBeInstanceOf(SessionLineReadError)
    expect(result.failure).toHaveProperty('cause.code', 'ENOENT')
    expect(native.streams).toHaveLength(0)
  })

  it('propagates an opted-in read failure after a prefix and closes the stream', async () => {
    const path = await setup()
    await writeFile(path, 'line\n'.repeat(100_000))
    native.failRead = true
    const lines: Array<string | Buffer> = []
    const result = await Effect.runPromise(
      Effect.result(
        Stream.runForEach(readSessionLinesStream(path, undefined, { readFailure: 'fail' }), line =>
          Effect.sync(() => lines.push(line)),
        ),
      ),
    )
    if (Result.isSuccess(result)) throw new Error('Expected a read failure')
    expect(result.failure).toBeInstanceOf(SessionLineReadError)
    expect(result.failure).toHaveProperty('cause.message', 'injected read failure')
    expect(lines.length).toBeGreaterThan(0)
    expect(native.streams[0]?.closed).toBe(true)
  })

  it('preserves empty lines without a preliminary stat for an explicitly uncapped source', async () => {
    const path = await setup()
    await writeFile(path, 'first\n\nlast')
    const lines = await Effect.runPromise(
      Stream.runCollect(readSessionLinesStream(path, undefined, { maxBytes: Infinity, preserveEmptyLines: true })),
    )
    expect([...lines]).toEqual(['first', '', 'last'])
    expect(native.statCalls).toBe(0)
    expect(native.streams).toHaveLength(1)
    expect(native.streams[0]?.closed).toBe(true)
  })

  it('closes an uncapped source after an early consumer stop', async () => {
    const path = await setup()
    await writeFile(path, 'first\nsecond\n')
    await Effect.runPromise(Stream.runHead(readSessionLinesStream(path, undefined, { maxBytes: Infinity })))
    expect(native.statCalls).toBe(0)
    expect(native.streams).toHaveLength(1)
    expect(native.streams[0]?.closed).toBe(true)
  })

  it('preserves byte offsets, blank-line skipping, and unterminated final lines', async () => {
    const path = await setup()
    const contents = Buffer.from('\nignored\nfirst\nlast')
    await writeFile(path, contents)
    const start = contents.indexOf(Buffer.from('first'))
    const tracker = { lastCompleteLineOffset: start }
    const lines = await Effect.runPromise(
      Stream.runCollect(
        readSessionLinesStream(path, undefined, { startByteOffset: start, byteOffsetTracker: tracker }),
      ),
    )
    expect([...lines]).toEqual(['first', 'last'])
    expect(tracker.lastCompleteLineOffset).toBe(start + 'first\n'.length)
  })

  it('skips missing and oversized files using the existing policies', async () => {
    const missing = await setup()
    const missingLines = await Effect.runPromise(Stream.runCollect(readSessionLinesStream(missing)))
    expect([...missingLines]).toEqual([])

    const oversized = join(root, 'oversized.jsonl')
    await writeFile(oversized, 'more than one byte')
    const oversizedLines = await Effect.runPromise(
      Stream.runCollect(readSessionLinesStream(oversized, undefined, { maxBytes: 1 })),
    )
    expect([...oversizedLines]).toEqual([])
    expect(native.streams).toHaveLength(0)
  })

  it('destroys and awaits the native ReadStream when its consumer is interrupted', async () => {
    const path = await setup()
    await writeFile(path, `${'line\n'.repeat(100_000)}`)

    const fiber = Effect.runFork(Stream.runForEach(readSessionLinesStream(path), () => Effect.never))
    while (native.streams.length === 0) await new Promise<void>(resolve => setImmediate(resolve))
    const stream = native.streams[0]
    if (!stream) throw new Error('ReadStream was not acquired')
    if (!stream.closed) await new Promise<void>(resolve => stream.once('open', () => resolve()))

    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(stream.closed).toBe(true)
  })

  it('waits for an in-flight non-cancelable stat before completing interruption', async () => {
    const path = await setup()
    await writeFile(path, 'line')
    native.delayStat = true
    let started!: () => void
    const statStarted = new Promise<void>(resolve => {
      started = resolve
    })
    native.onStatStarted = started

    const fiber = Effect.runFork(Stream.runCollect(readSessionLinesStream(path)))
    await statStarted
    let interrupted = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true
    })
    await Promise.resolve()
    expect(interrupted).toBe(false)
    native.releaseStat?.()
    await interruption
    expect(native.streams).toHaveLength(0)
  })
})
