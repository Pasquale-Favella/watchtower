import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { calculateSessionDetail } from '../src/main/session-detail-calculation.js'
import { createSessionsAtoms } from '../src/renderer/src/features/sessions/atoms.js'
import type { SessionDetail } from '../src/shared/schemas/views.js'
import { makeAnalyticsRpcTestClient } from './analytics-rpc-test-helper.js'
import { buildFixtureReport } from './fixtures/report.js'

const registries: AtomRegistry.AtomRegistry[] = []
function setup(session: (request: { sessionId: string; sourceId?: number }) => Promise<SessionDetail | null>) {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  const client = makeAnalyticsRpcTestClient(factory, { session })
  const { sessionQuery } = createSessionsAtoms(undefined, (request, selectionId) =>
    client.query('store:session', request, {
      serializationKey: selectionId,
      reactivityKeys: ['ledger', 'pricing'],
    }),
  )
  sessionQuery.pin(registry)
  return { registry, sessionQuery }
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
})

describe('source-aware session detail', () => {
  it('forwards explicit source identity and preserves its omission when unspecified', async () => {
    const session = vi.fn(async () => null)
    const { registry, sessionQuery } = setup(session)
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 2 })
    await vi.waitFor(() => expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Success'))
    expect(session).toHaveBeenLastCalledWith({ sessionId: 'duplicate', sourceId: 2 })
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate' })
    await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2))
    expect(session).toHaveBeenLastCalledWith({ sessionId: 'duplicate' })
    registry.dispose()
  })

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid source %s before the handler', async sourceId => {
    const session = vi.fn(async () => null)
    const { registry, sessionQuery } = setup(session)
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId })
    await vi.waitFor(() => expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Failure'))
    expect(session).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('forwards explicit source identity through RPC and drops an old source response', async () => {
    const base = buildFixtureReport()[0]?.sessions[0]
    if (!base) throw new Error('Missing session fixture')
    const detail = calculateSessionDetail(base)
    const pending: Array<{
      request: { sessionId: string; sourceId?: number }
      resolve: (value: SessionDetail | null) => void
    }> = []
    const { registry, sessionQuery } = setup(request => new Promise(resolve => pending.push({ request, resolve })))
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 1 })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 2 })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending.map(item => item.request)).toEqual([
      { sessionId: 'duplicate', sourceId: 1 },
      { sessionId: 'duplicate', sourceId: 2 },
    ])
    pending[1]?.resolve({ ...detail, project: 'second-source' })
    await vi.waitFor(() =>
      expect(AsyncResult.getOrThrow(registry.get(sessionQuery.resultAtom))?.project).toBe('second-source'),
    )
    pending[0]?.resolve({ ...detail, project: 'first-source' })
    await Promise.resolve()
    expect(AsyncResult.getOrThrow(registry.get(sessionQuery.resultAtom))?.project).toBe('second-source')
    expect(registry.get(sessionQuery.requestAtom)).toEqual({ sessionId: 'duplicate', sourceId: 2 })
  })

  it('drops an in-flight response after clearing detail', async () => {
    let resolve: ((value: SessionDetail | null) => void) | undefined
    const { registry, sessionQuery } = setup(
      () =>
        new Promise(done => {
          resolve = done
        }),
    )
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 1 })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    registry.set(sessionQuery.resetAtom, undefined)
    resolve?.(null)
    await Promise.resolve()
    expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Initial')
    expect(registry.get(sessionQuery.requestAtom)).toBeNull()
  })
})
