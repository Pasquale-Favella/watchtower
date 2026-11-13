/** How long the reader must stay away from the end before the "Scroll to end" pill appears. Hiding is immediate. */
export const SCROLL_PILL_SHOW_DELAY_MS = 150

export interface TimelineFollowState {
  /** The reader moved away from the end; new output must not pull the viewport down. */
  readonly released: boolean
  readonly atEnd: boolean
  readonly pill: 'hidden' | 'pending' | 'visible'
}

export type TimelineFollowEvent =
  | { readonly type: 'scrolledUp' }
  | { readonly type: 'atEndChanged'; readonly atEnd: boolean }
  | { readonly type: 'resume' }
  | { readonly type: 'pillDelayElapsed' }

/** Released state comes from a reader moving up, or from a remembered anchor restored on mount. */
export function initialTimelineFollow(restoredAnchor: boolean): TimelineFollowState {
  return normalize({ released: restoredAnchor, atEnd: !restoredAnchor, pill: 'hidden' })
}

function normalize(state: TimelineFollowState): TimelineFollowState {
  if (!state.released || state.atEnd) return { ...state, pill: 'hidden' }
  return { ...state, pill: state.pill === 'hidden' ? 'pending' : state.pill }
}

export function reduceTimelineFollow(state: TimelineFollowState, event: TimelineFollowEvent): TimelineFollowState {
  switch (event.type) {
    case 'scrolledUp':
      return normalize({ ...state, released: true, atEnd: false })
    case 'atEndChanged':
      // Reaching the end again resumes following; a transient gap while output streams does not release.
      return normalize({ ...state, atEnd: event.atEnd, released: event.atEnd ? false : state.released })
    case 'resume':
      return normalize({ ...state, released: false })
    case 'pillDelayElapsed':
      if (state.pill !== 'pending') return state
      return { ...state, pill: 'visible' }
  }
}
