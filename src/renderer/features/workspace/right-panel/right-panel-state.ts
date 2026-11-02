import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { ProjectId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

export const RIGHT_PANEL_DEFAULT_WIDTH = 540
export const RIGHT_PANEL_MIN_WIDTH = 360
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.7
/** The chat keeps at least this much width beside the panel. */
export const RIGHT_PANEL_CHAT_RESERVE = 360
/** Below this viewport width the panel opens as a sheet instead of taking inline space. */
export const RIGHT_PANEL_WIDE_BREAKPOINT = 980

const PANEL_STATE_KEY = 'watchtower.workspace.right-panel.v1'
const PANEL_WIDTH_KEY = 'watchtower.workspace.right-panel-width.v1'
const PANEL_RETENTION = 100

export type RightPanelTab = 'diff' | 'files'
export interface RightPanelPreference {
  readonly open: boolean
  readonly tab: RightPanelTab
}
export const DEFAULT_RIGHT_PANEL_PREFERENCE: RightPanelPreference = { open: false, tab: 'diff' }

const preferenceSchema = Schema.Struct({
  open: Schema.Boolean,
  tab: Schema.Literals(['diff', 'files']),
})
const preferencesSchema = Schema.Record(Schema.String, preferenceSchema)

/** Storage can be absent, blocked or throw in private contexts; every access degrades to defaults. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Preferences per Task key. Malformed or unreadable storage yields no remembered panels. */
export function readRightPanelPreferences(storage: Storage | null): Record<string, RightPanelPreference> {
  try {
    const raw = storage?.getItem(PANEL_STATE_KEY)
    if (!raw) return {}
    const decoded = Schema.decodeUnknownOption(preferencesSchema)(JSON.parse(raw))
    return Option.isSome(decoded) ? decoded.value : {}
  } catch {
    return {}
  }
}

/** Keeps the most recently written entries so the record cannot grow without bound. */
export function writeRightPanelPreferences(
  storage: Storage | null,
  preferences: Record<string, RightPanelPreference>,
): void {
  try {
    const entries = Object.entries(preferences)
    const bounded = Object.fromEntries(entries.slice(Math.max(0, entries.length - PANEL_RETENTION)))
    storage?.setItem(PANEL_STATE_KEY, JSON.stringify(bounded))
  } catch {
    /* Storage is an optimization; the panel still works for this session. */
  }
}

export function readRightPanelWidth(storage: Storage | null): number {
  try {
    const raw = storage?.getItem(PANEL_WIDTH_KEY)
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw)
    return Number.isFinite(value) ? value : RIGHT_PANEL_DEFAULT_WIDTH
  } catch {
    return RIGHT_PANEL_DEFAULT_WIDTH
  }
}

export function writeRightPanelWidth(storage: Storage | null, width: number): void {
  try {
    storage?.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
  } catch {
    /* Width resets to its default when storage is unavailable. */
  }
}

/**
 * Keeps the panel between its minimum and the smaller of 70% of the viewport and the space left beside
 * the chat. A narrow container never pushes the minimum below its floor.
 */
export function clampRightPanelWidth(width: number, viewportWidth: number, containerWidth: number): number {
  const ceiling = Math.max(
    RIGHT_PANEL_MIN_WIDTH,
    Math.min(Math.floor(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO), containerWidth - RIGHT_PANEL_CHAT_RESERVE),
  )
  return Math.min(ceiling, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)))
}

/** Scope without an undefined checkout key, which the strict RPC payload would otherwise reject. */
export function checkoutScope(projectId: ProjectId, checkoutId: WorkspaceCheckoutId | undefined): CheckoutScope {
  return checkoutId === undefined ? { projectId } : { projectId, checkoutId }
}
