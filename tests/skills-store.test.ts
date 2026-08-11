import { describe, expect, it, vi } from 'vitest'

function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

// The settings store persists via `createJSONStorage(() => localStorage)` at
// module load — install the memory storage BEFORE the dynamic import.
const memory = createMemoryStorage()
vi.stubGlobal('localStorage', memory)

const { useCoachSkillsStore } = await import('../src/renderer/src/features/coach-skills/store.js')

describe('Coach & Skills detection + dismissal (ADR 0017)', () => {
  it('loads the detection pool (the build-skill candidate source) for a scope', async () => {
    const payload = {
      period: { start: '2026-07-01', end: '2026-07-31' },
      summary: {
        sessions: 4, calls: 40, skillEvents: 8, bashEvents: 10, toolEvents: 3,
        drafts: 1, opportunities: 1, ghosts: 0,
      },
      drafts: [{
        name: 'data-fetch',
        source: 'skill',
        frequency: 6,
        spreadSessions: 2,
        spreadProjects: 1,
        costUSD: 3.5,
        turns: 4,
        latest: '2026-07-13T12:00:00.000Z',
        sample: 'data-fetch',
        sourceSessions: [{ sessionId: 'sess-a', project: 'demo', date: '2026-07-13', turns: 3, costUSD: 2 }],
      }],
      opportunities: [],
      ghosts: [],
    }
    mockWindow({ getSkills: () => Promise.resolve(payload) })
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    expect(useCoachSkillsStore.getState().detection.data?.drafts[0]?.name).toBe('data-fetch')
  })

  it('dismisses a pattern through the main process and reloads the detection pool', async () => {
    const dismissed: Array<{ source: string; name: string; reason: string }> = []
    const loaded: string[] = []
    mockWindow({
      dismissSkill: (request: { source: string; name: string; reason: string }) => {
        dismissed.push(request)
        return Promise.resolve({ ok: true })
      },
      getSkills: (scope: unknown) => {
        loaded.push(JSON.stringify(scope))
        return Promise.resolve(null)
      },
    })
    // Load the pool first so the post-dismiss reload has a scope to refetch.
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    await useCoachSkillsStore.getState().dismiss('skill', 'data-fetch', 'too-specific')
    expect(dismissed).toEqual([{ source: 'skill', name: 'data-fetch', reason: 'too-specific' }])
    // The dismissal landed, so the pool refetches against the same scope.
    expect(loaded.length).toBe(2)
  })

  it('keeps the detection pool untouched when a dismissal write fails', async () => {
    mockWindow({
      dismissSkill: () => Promise.resolve({ ok: false, error: 'invalid dismissal request' }),
      getSkills: () => Promise.resolve(null),
    })
    const keyBefore = useCoachSkillsStore.getState().detection.dataKey
    await useCoachSkillsStore.getState().dismiss('skill', 'data-fetch', 'not-a-skill')
    expect(useCoachSkillsStore.getState().detection.dataKey).toBe(keyBefore)
  })
})
