import { useAtomValue } from '@effect/atom-react'

import { type CoachState, coachStateAtom } from './atoms'

/** Selects a presentation value from the window-owned Coach state atom. */
export function useCoachState<Value>(select: (state: CoachState) => Value): Value {
  return select(useAtomValue(coachStateAtom))
}
