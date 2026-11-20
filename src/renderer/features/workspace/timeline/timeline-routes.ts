import { createContext, useContext } from 'react'

/** Actions a timeline row can route to the main chat's panels. Empty outside a side chat. */
export interface TimelineRoutes {
  readonly openDiff?: (() => void) | undefined
  readonly runShellCommand?: ((command: string) => void) | undefined
}

export const TimelineRoutesContext = createContext<TimelineRoutes>({})

export function useTimelineRoutes(): TimelineRoutes {
  return useContext(TimelineRoutesContext)
}
