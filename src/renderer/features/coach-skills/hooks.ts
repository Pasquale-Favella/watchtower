import { useAtomSet, useAtomValue } from '@effect/atom-react'

import {
  cancelCoachAtom,
  coachDetection,
  type CoachState,
  coachStateAtom,
  inspectHarnessAtom,
  loadHarnessesAtom,
  openCoachLoginTerminalAtom,
  refreshHarnessesAtom,
  resetSessionAtom,
  retryAssistantAtom,
  sendCoachAtom,
  setHarnessAtom,
  setModeIdAtom,
  setModelIdAtom,
} from '@/renderer/features/coach-skills/atoms'
import { preferencesAtom, setPreferencesAtom } from '@/renderer/features/settings/preferences-atoms'
import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query'

import { useCoachSkillDetection } from './skill-detection-hooks.js'

/** Selects a presentation value from the window-owned Coach state atom. */
export function useCoachState<Value>(select: (state: CoachState) => Value): Value {
  return select(useAtomValue(coachStateAtom))
}

/** Coach overview data, detection query, and hydration action. */
export function useCoachOverviewStore() {
  const detection = useCoachSkillDetection(coachDetection)
  return {
    detection,
    loadHarnesses: useAtomSet(loadHarnessesAtom),
    hydrated: useCoachState(state => state.hydrated),
  }
}

/** Coach preferences used by the Claude authentication hint. */
export function useCoachAuthStore() {
  const { allowHarnessApiKeyEnv } = useAtomValue(preferencesAtom)
  return { allowApiKeyEnv: allowHarnessApiKeyEnv, setPreferences: useAtomSet(setPreferencesAtom) }
}

/** Commands and query snapshot for the welcome screen pattern suggestions. */
export function useCoachWelcomeStore() {
  return { detection: querySnapshot(useAtomValue(coachDetection.resultAtom)) }
}

/** Harness picker state and actions for selecting a harness, model, or mode. */
export function useCoachPickerStore() {
  return {
    setHarness: useAtomSet(setHarnessAtom),
    resetSession: useAtomSet(resetSessionAtom),
    inspectHarness: useAtomSet(inspectHarnessAtom),
    setModelId: useAtomSet(setModelIdAtom),
    setModeId: useAtomSet(setModeIdAtom),
  }
}

/** Current conversation state and actions. */
export function useCoachConversationStore() {
  const state = useAtomValue(coachStateAtom)
  return {
    harnessKind: state.harnessKind,
    messages: state.messages,
    running: state.running,
    error: state.error,
    send: useAtomSet(sendCoachAtom),
    cancel: useAtomSet(cancelCoachAtom),
    resetSession: useAtomSet(resetSessionAtom),
  }
}

/** Thread presentation state and retry action. */
export function useCoachThreadStore() {
  return {
    running: useCoachState(state => state.running),
    retryAssistant: useAtomSet(retryAssistantAtom),
  }
}

/** Harness setup actions exposed to the setup panel. */
export function useCoachHarnessSetupStore() {
  return {
    refreshHarnesses: useAtomSet(refreshHarnessesAtom, { mode: 'promise' }),
    openLoginTerminal: useAtomSet(openCoachLoginTerminalAtom, { mode: 'promise' }),
  }
}

export type { ChatMessage, CoachKindCache, ToolNotice } from '@/renderer/features/coach-skills/atoms'
