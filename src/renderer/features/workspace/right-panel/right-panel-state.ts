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

const PANEL_STATE_KEY = 'watchtower.workspace.right-panel.v2'
/** Read only to carry v1 preferences ({ open, tab }) forward; never written. */
const LEGACY_PANEL_STATE_KEY = 'watchtower.workspace.right-panel.v1'
const PANEL_WIDTH_KEY = 'watchtower.workspace.right-panel-width.v1'
const PANEL_RETENTION = 100

/** Diff and the file browser are singletons. Other tabs identify one persistent resource. */
export const RIGHT_PANEL_SURFACES = ['diff', 'files'] as const
export type RightPanelSurfaceKind =
  'diff' | 'files' | 'file' | 'browser' | 'terminal' | 'device' | 'pull-requests' | 'pull-request' | 'side-chat'
export type RightPanelSurface =
  | (typeof RIGHT_PANEL_SURFACES)[number]
  | 'pull-requests'
  | `file:${string}`
  | `browser:${string}`
  | `terminal:${string}`
  | `device:${string}`
  | `pull-request:${string}`
  | `side-chat:${string}`

export function surfaceKind(surface: RightPanelSurface): RightPanelSurfaceKind {
  if (surface === 'diff' || surface === 'files' || surface === 'pull-requests') return surface
  return surface.slice(0, surface.indexOf(':')) as Exclude<RightPanelSurfaceKind, 'diff' | 'files' | 'pull-requests'>
}

export function surfaceResource(surface: RightPanelSurface): string {
  const separator = surface.indexOf(':')
  return separator < 0 ? '' : decodeURIComponent(surface.slice(separator + 1))
}

export function resourceSurface(
  kind: Exclude<RightPanelSurfaceKind, 'diff' | 'files' | 'pull-requests'>,
  resource: string,
): RightPanelSurface {
  return `${kind}:${encodeURIComponent(resource)}`
}

export function surfaceLabel(surface: RightPanelSurface): string {
  switch (surfaceKind(surface)) {
    case 'diff':
      return 'Diff'
    case 'files':
      return 'Files'
    case 'file':
      return surfaceResource(surface).split(/[\\/]/).at(-1) ?? 'File'
    case 'browser':
      return 'Browser'
    case 'terminal':
      return 'Terminal'
    case 'device':
      return 'Device'
    case 'pull-requests':
      return 'Pull requests'
    case 'pull-request':
      return `PR #${surfaceResource(surface)}`
    case 'side-chat':
      return 'Side chat'
  }
}

function validSurface(value: string): boolean {
  if (value === 'diff' || value === 'files' || value === 'pull-requests') return true
  if (!/^(?:file|browser|terminal|device|pull-request|side-chat):[^\s\0]+$/.test(value)) return false
  try {
    const resource = decodeURIComponent(value.slice(value.indexOf(':') + 1))
    return resource.length > 0 && ![...resource].some(character => character.charCodeAt(0) < 32)
  } catch {
    return false
  }
}

export interface RightPanelPreference {
  readonly open: boolean
  /** Open tabs, in strip order. */
  readonly surfaces: ReadonlyArray<RightPanelSurface>
  /** null while the panel shows its empty state. */
  readonly active: RightPanelSurface | null
  /** The panel fills the row and the chat column collapses. */
  readonly maximized: boolean
}
export const DEFAULT_RIGHT_PANEL_PREFERENCE: RightPanelPreference = {
  open: false,
  surfaces: [],
  active: null,
  maximized: false,
}

const surfaceSchema = Schema.String.check(Schema.isMaxLength(16_384), Schema.makeFilter(validSurface))
const preferenceSchema = Schema.Struct({
  open: Schema.Boolean,
  surfaces: Schema.Array(surfaceSchema),
  active: Schema.NullOr(surfaceSchema),
  maximized: Schema.Boolean,
})
const preferencesSchema = Schema.Record(Schema.String, preferenceSchema)
const legacyPreferencesSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ open: Schema.Boolean, tab: Schema.Literals(RIGHT_PANEL_SURFACES) }),
)

/** Storage can be absent, blocked or throw in private contexts; every access degrades to defaults. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readJson(storage: Storage | null, key: string): unknown {
  const raw = storage?.getItem(key)
  return raw ? JSON.parse(raw) : undefined
}

/**
 * Preferences per Task key. Malformed or unreadable storage yields no remembered panels. Without v2
 * entries, each v1 entry comes back as a panel holding its one remembered tab.
 */
export function readRightPanelPreferences(storage: Storage | null): Record<string, RightPanelPreference> {
  try {
    const current = readJson(storage, PANEL_STATE_KEY)
    if (current !== undefined) {
      const decoded = Schema.decodeUnknownOption(preferencesSchema)(current)
      return Option.isSome(decoded) ? normalizePreferences(decoded.value as Record<string, RightPanelPreference>) : {}
    }
    const legacy = Schema.decodeUnknownOption(legacyPreferencesSchema)(readJson(storage, LEGACY_PANEL_STATE_KEY))
    if (Option.isNone(legacy)) return {}
    return Object.fromEntries(
      Object.entries(legacy.value).map(([key, { open, tab }]) => [
        key,
        { open, surfaces: [tab], active: tab, maximized: false },
      ]),
    )
  } catch {
    return {}
  }
}

/** Drops duplicate tabs and an active surface that is not open, which hand-edited storage could hold. */
function normalizePreferences(preferences: Record<string, RightPanelPreference>): Record<string, RightPanelPreference> {
  return Object.fromEntries(
    Object.entries(preferences).map(([key, preference]) => {
      const surfaces = [...new Set(preference.surfaces)]
      const active = preference.active !== null && surfaces.includes(preference.active) ? preference.active : null
      return [key, { ...preference, surfaces, active: active ?? surfaces[0] ?? null }]
    }),
  )
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

/** Opens the panel on a surface, adding its tab at the end when it is not open yet. */
export function openSurface(preference: RightPanelPreference, surface: RightPanelSurface): RightPanelPreference {
  const surfaces = preference.surfaces.includes(surface) ? preference.surfaces : [...preference.surfaces, surface]
  return { ...preference, open: true, surfaces, active: surface }
}

/** Hides the panel when the surface is already showing, otherwise opens it there. Backs Mod+D for the diff. */
export function toggleSurface(preference: RightPanelPreference, surface: RightPanelSurface): RightPanelPreference {
  if (preference.open && preference.active === surface) return { ...preference, open: false }
  return openSurface(preference, surface)
}

/**
 * Closes one tab. The tab that takes its index becomes active, or the one before it when it was last.
 * Closing the last tab hides the panel, so reopening it shows the surface list.
 */
export function closeSurface(preference: RightPanelPreference, surface: RightPanelSurface): RightPanelPreference {
  const index = preference.surfaces.indexOf(surface)
  if (index < 0) return preference
  const surfaces = preference.surfaces.filter(item => item !== surface)
  if (surfaces.length === 0) return closeAllSurfaces(preference)
  const active =
    preference.active === surface ? (surfaces[Math.min(index, surfaces.length - 1)] ?? null) : preference.active
  return { ...preference, surfaces, active }
}

export function closeOtherSurfaces(preference: RightPanelPreference, keep: RightPanelSurface): RightPanelPreference {
  if (!preference.surfaces.includes(keep)) return preference
  return { ...preference, open: true, surfaces: [keep], active: keep }
}

export function closeSurfacesToRight(preference: RightPanelPreference, of: RightPanelSurface): RightPanelPreference {
  const index = preference.surfaces.indexOf(of)
  if (index < 0) return preference
  const surfaces = preference.surfaces.slice(0, index + 1)
  const active = preference.active !== null && surfaces.includes(preference.active) ? preference.active : of
  return { ...preference, surfaces, active }
}

export function closeAllSurfaces(preference: RightPanelPreference): RightPanelPreference {
  return { ...preference, surfaces: [], active: null, open: false, maximized: false }
}

/** Moves a tab one place left (-1) or right (+1) in the strip. Moving past either end does nothing. */
export function moveSurface(
  preference: RightPanelPreference,
  surface: RightPanelSurface,
  offset: -1 | 1,
): RightPanelPreference {
  return moveSurfaceTo(preference, surface, preference.surfaces.indexOf(surface) + offset)
}

export function moveSurfaceTo(
  preference: RightPanelPreference,
  surface: RightPanelSurface,
  target: number,
): RightPanelPreference {
  const index = preference.surfaces.indexOf(surface)
  if (index < 0 || target < 0 || target >= preference.surfaces.length) return preference
  const surfaces = [...preference.surfaces]
  surfaces.splice(index, 1)
  surfaces.splice(target, 0, surface)
  return { ...preference, surfaces }
}

/** Transfers the draft layout without removing the source until navigation has committed. */
export function transferRightPanelPreference(storage: Storage | null, from: string, to: string): void {
  if (from === to) return
  const preferences = readRightPanelPreferences(storage)
  const source = preferences[from]
  if (!source || preferences[to]) return
  writeRightPanelPreferences(storage, { ...preferences, [to]: source })
}

export function transferRightPanelState(from: string, to: string): void {
  transferRightPanelPreference(browserStorage(), from, to)
}

export function rememberRightPanelSurface(taskKey: string, surface: RightPanelSurface, activate: boolean): void {
  const storage = browserStorage()
  const preferences = readRightPanelPreferences(storage)
  const current = preferences[taskKey] ?? DEFAULT_RIGHT_PANEL_PREFERENCE
  const next = openSurface(current, surface)
  writeRightPanelPreferences(storage, {
    ...preferences,
    [taskKey]: activate ? next : { ...next, active: current.active, open: current.open },
  })
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
