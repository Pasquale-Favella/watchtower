import { useAtomValue } from '@effect/atom-react'
import { useMemo } from 'react'

import { preferencesAtom } from '@/renderer/features/settings/preferences-atoms.js'
import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'
import { useOverviewScope } from '@/renderer/stores/hooks/use-scope-store.js'

import { coachSkillDetection } from './skill-detection-atoms.js'

export function useCoachSkillDetection(slot = coachSkillDetection) {
  const scope = useOverviewScope()
  const { skillsFrequency, skillsSpread } = useAtomValue(preferencesAtom)
  const request = useMemo(
    () => ({ scope, frequency: skillsFrequency, spread: skillsSpread }),
    [scope, skillsFrequency, skillsSpread],
  )
  return useRemoteQuery(slot, request, value => `${JSON.stringify(value.scope)}:${value.frequency}:${value.spread}`)
}
