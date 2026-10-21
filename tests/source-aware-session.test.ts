import { afterEach, describe, expect, it, vi } from 'vitest'

import { calculateSessionDetail } from '../src/main/session-detail-calculation.js'
import { useSessionsStore } from '../src/renderer/src/features/sessions/store.js'
import { fetchSession } from '../src/renderer/src/shared/lib/api.js'
import type { SessionDetail } from '../src/shared/schemas/views.js'
import { buildFixtureReport } from './fixtures/report.js'

afterEach(() => {
  useSessionsStore.setState(useSessionsStore.getInitialState(), true)
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
    const first = useSessionsStore.getState().loadSession('duplicate', 1)
    const second = useSessionsStore.getState().loadSession('duplicate', 2)
    expect(getSession.mock.calls).toEqual([
      ['duplicate', 1],
      ['duplicate', 2],
    ])
    pending[1]?.({ ...detail, project: 'second-source' })
    await second
    expect(useSessionsStore.getState().session?.project).toBe('second-source')
    pending[0]?.({ ...detail, project: 'first-source' })
    await first
    expect(useSessionsStore.getState().session?.project).toBe('second-source')
    expect(useSessionsStore.getState().sessionKey).toBe(JSON.stringify(['duplicate', 2]))
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
    const loading = useSessionsStore.getState().loadSession('duplicate', 1)
    useSessionsStore.getState().clearSession()
    resolve?.(null)
    await loading
    expect(useSessionsStore.getState()).toMatchObject({ sessionStatus: 'idle', sessionKey: null })
  })
})
