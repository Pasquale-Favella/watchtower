import type { RightPanelSurface } from './right-panel-state.js'

interface CloseActions {
  readonly confirm?: ((surface: RightPanelSurface) => boolean | Promise<boolean>) | undefined
  readonly release?: ((surface: RightPanelSurface) => void | Promise<void>) | undefined
  readonly remove: (surface: RightPanelSurface) => void
}

/** Bulk closes collect every confirmation before releasing a resource or changing the tab list. */
export async function closePanelSurfaces(
  surfaces: readonly RightPanelSurface[],
  actions: CloseActions,
): Promise<boolean> {
  for (const surface of surfaces) {
    if (actions.confirm && !(await actions.confirm(surface))) return false
  }
  for (const surface of surfaces) {
    await actions.release?.(surface)
    actions.remove(surface)
  }
  return true
}
