import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { motionClass } from '@/shared/lib/motion'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { ConversationView } from './conversation'

/** The Coach section (ADR 0017, conversation prototype picked on map 58): a
 *  ChatGPT-style chat surface where EVERY harness run is a conversation —
 *  free-form guidance, or a skill crafted together when a detected pattern
 *  seeds the dialogue. One surface, no Coach/Skills room switch: the prompt
 *  bar carries the provider (harness) + agent-declared model/mode pickers,
 *  and detected patterns are chips floating under the prompt card. No consent
 *  gate — the harnesses are the machine's own, and runs are user-initiated.
 *  The view is a thin composition root: hydration lives here, the surface is
 *  the colocated conversation components (elements.ai-sdk.dev-inspired). */
export function CoachSkillsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const detection = useCoachSkillsStore(s => s.detection)
  const loadHarnesses = useCoachSkillsStore(s => s.loadHarnesses)

  // Hydrate: detection on scope change, harnesses once.
  useEffect(() => {
    void detection.load(scope)
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadHarnesses()
  }, [loadHarnesses])

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      <ConversationView />

      {detection.error && <ErrorPanel message={detection.error} />}
    </div>
  )
}
