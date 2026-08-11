import { create } from 'zustand'
import { fetchSkills } from '@/shared/lib/api'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import type { SkillsPayload } from '../../../../shared/schemas/skills.js'

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

/** The Skills section's scoped payload (ADR 0011, ticket 24). The detection
 * gate (frequency × spread) is an app setting: the fetch closure reads the
 * current values from the settings store, so every load — scope switch or
 * refresh tick — uses the tunable thresholds, not code constants. */
export interface SkillsState {
  view: ScopedDataSlice<SkillsPayload>
}

export const useSkillsStore = create<SkillsState>()((set, get) => ({
  view: scopedDataSlice<SkillsPayload>(
    scope => fetchSkills(scope, {
      frequency: useSettingsStore.getState().skillsFrequency,
      spread: useSettingsStore.getState().skillsSpread,
    }),
    patch => set(state => ({ view: { ...state.view, ...patch } })),
    () => get().view,
  ),
}))

subscribeToRefresh(() => {
  void useSkillsStore.getState().view.reload()
})

useSettingsStore.subscribe(watchThresholds)
