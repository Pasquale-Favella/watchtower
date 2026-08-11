import { describe, expect, it, vi } from 'vitest'
import type { SkillCandidate } from '../src/shared/schemas/skills.js'

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

const { useSkillsStore } = await import('../src/renderer/src/features/skills/store.js')

const candidate: SkillCandidate = {
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
}

describe('Skills store (ticket 25)', () => {
  it('dismisses a pattern through the main process and reloads the board', async () => {
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
    // Load the board first so the post-dismiss reload has a scope to refetch.
    await useSkillsStore.getState().view.load({ period: 'lifetime' })
    await useSkillsStore.getState().dismiss('skill', 'data-fetch', 'too-specific')
    expect(dismissed).toEqual([{ source: 'skill', name: 'data-fetch', reason: 'too-specific' }])
    // The dismissal landed, so the board refetches against the same scope.
    expect(loaded.length).toBe(2)
  })

  it('keeps the board untouched when a dismissal write fails', async () => {
    mockWindow({
      dismissSkill: () => Promise.resolve({ ok: false, error: 'invalid dismissal request' }),
      getSkills: () => Promise.resolve(null),
    })
    const keyBefore = useSkillsStore.getState().view.dataKey
    await useSkillsStore.getState().dismiss('skill', 'data-fetch', 'not-a-skill')
    expect(useSkillsStore.getState().view.dataKey).toBe(keyBefore)
  })

  it('tracks harness prose per draft keyed by source + name', async () => {
    mockWindow({
      getDraftProse: () => Promise.resolve({ ok: true, markdown: '# data-fetch\n\n## Description\nFetch data.' }),
    })
    await useSkillsStore.getState().generateProse(candidate)
    expect(useSkillsStore.getState().prose['skill\u0000data-fetch'])
      .toEqual({ status: 'ready', markdown: '# data-fetch\n\n## Description\nFetch data.' })
  })

  it('records a prose error without breaking the board', async () => {
    mockWindow({
      getDraftProse: () => Promise.resolve({ ok: false, error: 'consent required' }),
    })
    await useSkillsStore.getState().generateProse(candidate)
    expect(useSkillsStore.getState().prose['skill\u0000data-fetch'])
      .toEqual({ status: 'error', error: 'consent required' })
  })
})
