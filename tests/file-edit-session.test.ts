import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileEditSession } from '../src/renderer/features/workspace/right-panel/file-edit-session.js'

afterEach(() => vi.useRealTimers())

describe('file edit save queue', () => {
  it('debounces edits and uses the original disk contents as the expected revision', async () => {
    vi.useFakeTimers()
    const persist = vi.fn(async () => undefined)
    const session = new FileEditSession({ content: 'original', persist, changed: () => {} })
    session.change('first')
    session.change('second')
    await vi.advanceTimersByTimeAsync(400)
    expect(persist.mock.calls).toEqual([['second', 'original']])
    expect(session.snapshot).toMatchObject({ content: 'second', savedContent: 'second', saving: false, error: null })
  })

  it('serializes an edit made during a pending write against the newly saved revision', async () => {
    let finish: (() => void) | undefined
    const calls: string[][] = []
    const session = new FileEditSession({
      content: 'A',
      changed: () => {},
      persist: async (content, expected) => {
        calls.push([content, expected])
        if (calls.length === 1)
          await new Promise<void>(resolve => {
            finish = resolve
          })
        return undefined
      },
    })
    session.change('B')
    const flushed = session.flush()
    session.change('C')
    expect(calls).toEqual([['B', 'A']])
    finish?.()
    expect(await flushed).toBe(true)
    expect(calls).toEqual([
      ['B', 'A'],
      ['C', 'B'],
    ])
    expect(session.snapshot.savedContent).toBe('C')
  })

  it('retains failed edits and retries them without overwriting the expected revision', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('Conflict')).mockResolvedValue(undefined)
    const session = new FileEditSession({ content: 'disk', changed: () => {}, persist })
    session.change('draft')
    expect(await session.flush()).toBe(false)
    expect(session.snapshot).toMatchObject({ content: 'draft', savedContent: 'disk', error: 'Conflict' })
    expect(await session.flush()).toBe(true)
    expect(persist.mock.calls).toEqual([
      ['draft', 'disk'],
      ['draft', 'disk'],
    ])
  })

  it('keeps local edits through external changes and ignores an echoed stale read', async () => {
    const session = new FileEditSession({ content: 'disk', changed: () => {}, persist: async () => undefined })
    session.change('saved')
    await session.flush()
    session.receive('disk')
    expect(session.snapshot.content).toBe('saved')
    session.change('draft')
    session.receive('external')
    expect(session.snapshot.content).toBe('draft')
    expect(session.snapshot.error).toContain('changed on disk')
    session.reload('external')
    expect(session.snapshot).toMatchObject({ content: 'external', savedContent: 'external', error: null })
  })

  it('distinguishes a real external revert from an older read by the disk revision', async () => {
    const session = new FileEditSession({ content: 'A', revision: 'r1', changed: () => {}, persist: async () => 'r2' })
    session.change('B')
    await session.flush()
    session.receive('A', 'r1')
    expect(session.snapshot.content).toBe('B')
    session.receive('A', 'r3')
    expect(session.snapshot).toMatchObject({ content: 'A', savedContent: 'A', error: null })
  })

  it('applies a fresh read arriving during a write after its save response settles', async () => {
    let finish: ((revision: string) => void) | undefined
    const session = new FileEditSession({
      content: 'A',
      revision: 'r1',
      changed: () => {},
      persist: () =>
        new Promise<string>(resolve => {
          finish = resolve
        }),
    })
    session.change('B')
    const saving = session.flush()
    session.receive('C', 'r3')
    expect(session.snapshot.content).toBe('B')
    finish?.('r2')
    expect(await saving).toBe(true)
    expect(session.snapshot).toMatchObject({ content: 'C', savedContent: 'C', saving: false })
  })
})
