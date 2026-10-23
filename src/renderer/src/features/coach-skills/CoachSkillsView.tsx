import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useEffect, useMemo } from 'react'

import { overviewScopeAtom } from '@/app/atoms/scope'
import { useRemoteQuery } from '@/app/hooks/use-remote-query'
import { coachDetection, loadHarnessesAtom } from '@/features/coach-skills/atoms'
import { useCoachState } from '@/features/coach-skills/hooks'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { motionClass } from '@/shared/lib/motion'
import { cn } from '@/shared/lib/utils'

import { ConversationView } from './conversation'

/** The Coach section (ADR 0017, conversation prototype picked on map 58): a
 *  roomy chat surface where EVERY harness run is a conversation —
 *  free-form guidance, or a skill crafted together by asking the harness
 *  directly (its ledger tools let it discover real patterns itself). One
 *  surface, no Coach/Skills room switch and no separated cards: the chat owns
 *  the viewport height (min-h-0 flex-1), so the transcript scrolls inside
 *  while the prompt bar stays pinned. The welcome screen hosts sample prompts
 *  and the suggested-skill chips; once a conversation starts the input is the
 *  surface. No consent gate — the harnesses are the machine's own, and runs
 *  are user-initiated. The view is a thin composition root: hydration lives
 *  here, the surface is the colocated conversation components
 *  (elements.ai-sdk.dev-inspired). */
export function CoachSkillsView(): React.JSX.Element {
  const scope = useAtomValue(overviewScopeAtom)
  const preferences = useAtomValue(preferencesAtom)
  const loadHarnesses = useAtomSet(loadHarnessesAtom)
  const state = useCoachState(s => s)
  const request = useMemo(
    () => ({ scope, frequency: preferences.skillsFrequency, spread: preferences.skillsSpread }),
    [scope, preferences.skillsFrequency, preferences.skillsSpread],
  )
  const detection = useRemoteQuery(
    coachDetection,
    request,
    value => `${JSON.stringify(value.scope)}:${value.frequency}:${value.spread}`,
  )

  useEffect(() => {
    if (!state.hydrated) loadHarnesses(undefined)
  }, [state.hydrated, loadHarnesses])

  return (
    <div
      className={cn('flex min-h-0 w-full max-w-[1180px] flex-1 flex-col', motionClass('flex flex-col', 'section-fade'))}
    >
      <ConversationView />

      {detection.error && <ErrorPanel message={detection.error} />}
    </div>
  )
}
