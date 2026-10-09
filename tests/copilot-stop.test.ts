import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  readSessionFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
}))

vi.mock('../src/main/pipeline/fs-utils.js', () => ({
  readSessionFile: (...args: unknown[]) => hooks.readSessionFile(...args),
}))

vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => hooks.readdir(...args),
  stat: (...args: unknown[]) => hooks.stat(...args),
}))

vi.mock('../src/main/pipeline/sqlite.js', () => ({
  openDatabase: vi.fn(() => ({ query: (...args: unknown[]) => hooks.query(...args), close: () => hooks.close() })),
}))

import { createCopilotProvider } from '../src/main/pipeline/providers/copilot.js'
import type { SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

describe('Copilot cooperative stop', () => {
  beforeEach(() => {
    hooks.readSessionFile.mockReset()
    hooks.readdir.mockReset()
    hooks.stat.mockReset()
    hooks.query.mockReset()
    hooks.close.mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('passes the scan signal to a pending file read and settles with the stable abort error', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    let startRead!: () => void
    let finishRead!: () => void
    const started = new Promise<void>(resolve => {
      startRead = resolve
    })
    const drained = new Promise<void>(resolve => {
      finishRead = resolve
    })
    hooks.readSessionFile.mockImplementation(
      (_path: string, _encoding: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startRead()
          options.signal?.addEventListener(
            'abort',
            () => {
              void drained.then(() => reject(options.signal?.reason))
            },
            { once: true },
          )
        }),
    )
    const parser = createCopilotProvider().createSessionParser(jsonlSource, new Set(), undefined, {
      signal: controller.signal,
    })

    const pending = parser.parse().next()
    const settled = vi.fn()
    void pending.then(settled, settled)
    await started
    controller.abort(abort)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finishRead()
    await expect(pending).rejects.toBe(abort)
    expect(settled).toHaveBeenCalledOnce()
    expect(hooks.readSessionFile).toHaveBeenCalledOnce()
    expect(hooks.readSessionFile.mock.calls[0]?.[2]).toEqual({ signal: controller.signal })
  })

  it('does no file or database IO when discovery starts pre-aborted', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)

    await expect(createCopilotProvider().discoverSessions({ signal: controller.signal })).rejects.toBe(abort)
    expect(hooks.readdir).not.toHaveBeenCalled()
    expect(hooks.stat).not.toHaveBeenCalled()
    expect(hooks.readSessionFile).not.toHaveBeenCalled()
    expect(hooks.query).not.toHaveBeenCalled()
  })

  it('closes a session-store database once on cancellation and does not retain partial rollup coverage', async () => {
    hooks.query.mockReturnValue([
      {
        id: 1,
        session_id: 'sess-1',
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        initiator: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        cwd: null,
        repository: null,
      },
    ])
    const provider = createCopilotProvider()
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const storeSource = {
      path: '/copilot/session-store.db',
      project: 'copilot-cli',
      provider: 'copilot',
      sourceType: 'sessionstore',
      mtime: '2026-01-01T00:00:00.000Z',
    } as SessionSource
    const store = provider.createSessionParser(storeSource, new Set(), undefined, { signal: controller.signal }).parse()

    expect((await store.next()).done).toBe(false)
    controller.abort(abort)
    await expect(store.next()).rejects.toBe(abort)
    expect(hooks.close).toHaveBeenCalledOnce()

    hooks.readSessionFile.mockResolvedValue(
      JSON.stringify({ type: 'session.start', data: { selectedModel: 'claude-sonnet-4-6' } }) +
        '\n' +
        JSON.stringify({
          type: 'session.shutdown',
          data: { modelMetrics: { 'claude-sonnet-4-6': { usage: { inputTokens: 100 } } } },
        }),
    )
    const rollups = provider.createSessionParser(jsonlSource, new Set()).parse()
    expect((await rollups.next()).value?.deduplicationKey).toBe('copilot:sess-1:shutdown:claude-sonnet-4-6')
    await rollups.return(undefined)
  })

  it('does not publish session-store coverage when closing the database fails', async () => {
    hooks.query.mockReturnValue([
      {
        id: 1,
        session_id: 'sess-1',
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        initiator: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        cwd: null,
        repository: null,
      },
    ])
    hooks.close.mockImplementation(() => {
      throw new Error('close failed')
    })
    const provider = createCopilotProvider()
    const storeSource = {
      path: '/copilot/session-store.db',
      project: 'copilot-cli',
      provider: 'copilot',
      sourceType: 'sessionstore',
      mtime: '2026-01-01T00:00:00.000Z',
    } as SessionSource
    const store = provider.createSessionParser(storeSource, new Set()).parse()

    expect((await store.next()).done).toBe(false)
    await expect(store.next()).rejects.toThrow('close failed')
    expect(hooks.close).toHaveBeenCalledOnce()

    hooks.readSessionFile.mockResolvedValue(
      JSON.stringify({ type: 'session.start', data: { selectedModel: 'claude-sonnet-4-6' } }) +
        '\n' +
        JSON.stringify({
          type: 'session.shutdown',
          data: { modelMetrics: { 'claude-sonnet-4-6': { usage: { inputTokens: 100 } } } },
        }),
    )
    const rollups = provider.createSessionParser(jsonlSource, new Set()).parse()
    expect((await rollups.next()).value?.deduplicationKey).toBe('copilot:sess-1:shutdown:claude-sonnet-4-6')
    await rollups.return(undefined)
  })
})

const jsonlSource = {
  path: '/copilot/session-state/sess-1/events.jsonl',
  project: 'copilot',
  provider: 'copilot',
  sourceType: 'jsonl',
  sessionKind: 'cli',
} as SessionSource
