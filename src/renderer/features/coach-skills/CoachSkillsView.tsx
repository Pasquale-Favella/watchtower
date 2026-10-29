import { useEffect } from 'react'

import { useCoachOverviewStore } from '@/renderer/features/coach-skills/hooks'
import { ErrorPanel } from '@/renderer/components/ErrorPanel'
import { motionClass } from '@/renderer/shared/lib/motion'
import { cn } from '@/renderer/shared/lib/utils'

import { ConversationView } from '@/renderer/features/coach-skills/conversation'

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
  const { detection, loadHarnesses, hydrated } = useCoachOverviewStore()

  useEffect(() => {
    if (!hydrated) loadHarnesses(undefined)
  }, [hydrated, loadHarnesses])

  return (
    <div
      className={cn('flex min-h-0 w-full max-w-[1180px] flex-1 flex-col', motionClass('flex flex-col', 'section-fade'))}
    >
      <ConversationView />

      {detection.error && <ErrorPanel message={detection.error} />}
    </div>
  )
}
