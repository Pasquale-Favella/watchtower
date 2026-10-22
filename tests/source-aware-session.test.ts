import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { calculateSessionDetail } from '../src/main/session-detail-calculation.js'
import { createSessionsAtoms } from '../src/renderer/src/features/sessions/atoms.js'
import { fetchSession } from '../src/renderer/src/shared/lib/api.js'
import type { SessionDetail } from '../src/shared/schemas/views.js'
import { buildFixtureReport } from './fixtures/report.js'

const registries: AtomRegistry.AtomRegistry[] = []
function setup() {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const { sessionQuery } = createSessionsAtoms(Atom.context())
  sessionQuery.pin(registry)
  return { registry, sessionQuery }
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
})

describe('source-aware session detail', () => {
  it('forwards explicit source identity and preserves the legacy IPC argument list', async () => {
    const getSession = vi.fn(() => Promise.resolve(null))
    vi.stubGlobal('window', { api: { getSession } })
    expect(await fetchSession('duplicate', 2)).toEqual({ ok: true, data: null })
    expect(getSession).toHaveBeenLastCalledWith('duplicate', 2)
    await fetchSession('duplicate')
    expect(getSession).toHaveBeenLastCalledWith('duplicate')
  })

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid source %s before IPC', async sourceId => {
    const getSession = vi.fn(() => Promise.resolve(null))
    vi.stubGlobal('window', { api: { getSession } })
    expect(await fetchSession('duplicate', sourceId)).toMatchObject({ ok: false })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('drops an old source response after navigating to another source with the same public ID', async () => {
    const base = buildFixtureReport()[0]?.sessions[0]
    if (!base) throw new Error('Missing session fixture')
    const detail = calculateSessionDetail(base)
    const pending: ((value: SessionDetail | null) => void)[] = []
    const getSession = vi.fn(() => new Promise<SessionDetail | null>(resolve => pending.push(resolve)))
    vi.stubGlobal('window', { api: { getSession } })
    const { registry, sessionQuery } = setup()
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 1 })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 2 })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(getSession.mock.calls).toEqual([
      ['duplicate', 1],
      ['duplicate', 2],
    ])
    pending[1]?.({ ...detail, project: 'second-source' })
    await vi.waitFor(() =>
      expect(AsyncResult.getOrThrow(registry.get(sessionQuery.resultAtom))?.project).toBe('second-source'),
    )
    pending[0]?.({ ...detail, project: 'first-source' })
    await Promise.resolve()
    expect(AsyncResult.getOrThrow(registry.get(sessionQuery.resultAtom))?.project).toBe('second-source')
    expect(registry.get(sessionQuery.requestAtom)).toEqual({ sessionId: 'duplicate', sourceId: 2 })
  })

  it('drops an in-flight response after clearing detail', async () => {
    let resolve: ((value: SessionDetail | null) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        getSession: () =>
          new Promise<SessionDetail | null>(done => {
            resolve = done
          }),
      },
    })
    const { registry, sessionQuery } = setup()
    registry.set(sessionQuery.requestAtom, { sessionId: 'duplicate', sourceId: 1 })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    registry.set(sessionQuery.resetAtom, undefined)
    resolve?.(null)
    await Promise.resolve()
    expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Initial')
    expect(registry.get(sessionQuery.requestAtom)).toBeNull()
  })
})
