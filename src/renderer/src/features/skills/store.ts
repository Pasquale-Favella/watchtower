import { create } from 'zustand'
import { fetchDismissSkill, fetchDraftProse, fetchSkills } from '@/shared/lib/api'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import type { SkillCandidate, SkillsPayload, SkillsSource } from '../../../../shared/schemas/skills.js'

/** Per-draft prose state (ticket 25): the harness-authored SKILL.md body for a
 *  candidate, generated on demand (one harness run per card), keyed by
 *  `${source}\0${name}`. Consent-gated main-side; template drafts are the
 *  default when absent or consent is off. */
export interface DraftProseState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  markdown?: string
  error?: string
}

/** The Skills section's state (ADR 0011, tickets 24–25): the scoped detection
 *  payload plus the review-flow actions. The detection gate (frequency ×
 *  spread) is an app setting — the fetch closure reads the current values from
 *  the settings store, so every load uses the tunable thresholds. */
export interface SkillsState {
  view: ScopedDataSlice<SkillsPayload>
  prose: Record<string, DraftProseState>
  /** Not-a-skill signal (ledger-persisted main-side): dismiss a pattern so the
   *  detector filters it out of drafts and opportunities on the next fetch. */
  dismiss: (source: SkillsSource, name: string, reason: string) => Promise<void>
  /** Consent-gated harness prose for one draft card. */
  generateProse: (candidate: SkillCandidate) => Promise<void>
}

const proseKey = (candidate: SkillCandidate): string => `${candidate.source}\0${candidate.name}`

export const useSkillsStore = create<SkillsState>()((set, get) => ({
  view: scopedDataSlice<SkillsPayload>(
    scope => fetchSkills(scope, {
      frequency: useSettingsStore.getState().skillsFrequency,
      spread: useSettingsStore.getState().skillsSpread,
    }),
    patch => set(state => ({ view: { ...state.view, ...patch } })),
    () => get().view,
  ),
  prose: {},
  dismiss: async (source, name, reason) => {
    const result = await fetchDismissSkill({ source, name, reason })
    if (result.ok && result.data.ok) {
      void get().view.reload()
    }
  },
  generateProse: async (candidate) => {
    const key = proseKey(candidate)
    if (get().prose[key]?.status === 'loading') return
    set(state => ({ prose: { ...state.prose, [key]: { status: 'loading' } } }))
    const result = await fetchDraftProse({
      source: candidate.source,
      name: candidate.name,
      frequency: candidate.frequency,
      spreadSessions: candidate.spreadSessions,
      spreadProjects: candidate.spreadProjects,
      costUSD: candidate.costUSD,
      turns: candidate.turns,
    })
    let next: DraftProseState
    if (!result.ok) next = { status: 'error', error: result.error }
    else if (result.data.ok) next = { status: 'ready', markdown: result.data.markdown }
    else next = { status: 'error', error: result.data.error }
    set(state => ({ prose: { ...state.prose, [key]: next } }))
  },
}))

subscribeToRefresh(() => {
  void useSkillsStore.getState().view.reload()
})

/** Refetch the mounted Skills view whenever the detection gate changes in
 * Settings › Skills — the settings store is the source the fetch reads, and
 * tuning the thresholds must repaint the board without a manual refresh. */
let lastThresholdKey = ''
function watchThresholds(): void {
  const state = useSettingsStore.getState()
  const key = `${state.skillsFrequency}\0${state.skillsSpread}`
  if (key !== lastThresholdKey) {
    lastThresholdKey = key
    void useSkillsStore.getState().view.reload()
  }
}

useSettingsStore.subscribe(watchThresholds)
