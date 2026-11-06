import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import { runWorkspaceOperation } from '@/renderer/features/workspace/workspace-operation.js'

async function until(read: () => boolean): Promise<void> {
  for (let attempt = 0; !read() && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
  expect(read()).toBe(true)
}

describe('workspace operation ownership', () => {
  it('handles synchronous results and removes completed invocation atoms', async () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 1, timeoutResolution: 1 })
    let nodes = 0
    registry.onNodeAdded = () => {
      nodes += 1
    }
    registry.onNodeRemoved = () => {
      nodes -= 1
    }
    const makeAtom = () => Atom.fn<string>()(request => Effect.succeed(request), { concurrent: true })
    expect(await runWorkspaceOperation(registry, makeAtom, 'result')).toBe('result')
    await until(() => nodes === 0)
    registry.dispose()
  })

  it('returns each overlapping caller its own result and never cancels a pending command', async () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 1, timeoutResolution: 1 })
    const complete = new Map<string, (effect: Effect.Effect<string>) => void>()
    const canceled: string[] = []
    const makeAtom = () =>
      Atom.fn<string>()(
        request =>
          Effect.callback<string>(resume => {
            complete.set(request, resume)
            return Effect.sync(() => {
              canceled.push(request)
            })
          }),
        { concurrent: true },
      )
    try {
      const first = runWorkspaceOperation(registry, makeAtom, 'command-A')
      const second = runWorkspaceOperation(registry, makeAtom, 'query-B')
      await until(() => complete.size === 2)
      complete.get('query-B')?.(Effect.succeed('B-only'))
      expect(await second).toBe('B-only')
      expect(canceled).not.toContain('command-A')
      complete.get('command-A')?.(Effect.succeed('A-only'))
      expect(await first).toBe('A-only')
    } finally {
      registry.dispose()
    }
  })

  it('isolates a failed request and releases pending work when its registry is disposed', async () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 1, timeoutResolution: 1 })
    const complete = new Map<string, (effect: Effect.Effect<string, Error>) => void>()
    const released: string[] = []
    const makeAtom = () =>
      Atom.fn<string>()(
        request =>
          Effect.callback<string, Error>(resume => {
            complete.set(request, resume)
            return Effect.sync(() => {
              released.push(request)
            })
          }),
        { concurrent: true },
      )
    const rejected = runWorkspaceOperation(registry, makeAtom, 'failure').then(
      () => false,
      () => true,
    )
    void runWorkspaceOperation(registry, makeAtom, 'pending').then(
      () => false,
      () => true,
    )
    await until(() => complete.size === 2)
    complete.get('failure')?.(Effect.fail(new Error('controlled failure')))
    expect(await rejected).toBe(true)
    expect(released).not.toContain('pending')
    registry.dispose()
    await until(() => released.includes('pending'))
  })
})
