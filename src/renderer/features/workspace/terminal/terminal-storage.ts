import * as Schema from 'effect/Schema'

import {
  TERMINAL_IDS,
  TERMINAL_MAX_PER_TASK,
  type TerminalFrame,
  type TerminalId,
  terminalIdSchema,
} from '@/shared/schemas/terminal.js'

const STORAGE_KEY = 'watchtower.workspace.terminal-drawer.v1'
export const TERMINAL_DRAWER_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
export const TERMINAL_DRAWER_MAX_TASKS = 40
export const TERMINAL_DRAWER_DEFAULT_HEIGHT = 280
export const TERMINAL_DRAWER_MIN_HEIGHT = 180
/** Space kept above the drawer so the conversation header and composer stay visible. */
export const TERMINAL_DRAWER_CHROME_RESERVE = 240
export const TERMINAL_DRAWER_MAX_VIEWPORT_FRACTION = 0.75

export const terminalSplitDirectionSchema = Schema.Literals(['horizontal', 'vertical'])
export type TerminalSplitDirection = Schema.Schema.Type<typeof terminalSplitDirectionSchema>

/** Terminals shown together. Horizontal places them side by side, vertical stacks them. */
const groupSchema = Schema.Struct({
  terminals: Schema.Array(terminalIdSchema),
  direction: terminalSplitDirectionSchema,
})
export type TerminalGroup = Schema.Schema.Type<typeof groupSchema>

const entrySchema = Schema.Struct({
  open: Schema.Boolean,
  height: Schema.Finite,
  /** null until the Task first records its tabs, so a drawer opened without tabs still opens one terminal. */
  terminals: Schema.NullOr(Schema.Array(terminalIdSchema)),
  activeTerminal: Schema.NullOr(terminalIdSchema),
  /** Absent in entries written before splits existed; each terminal then stands alone. */
  groups: Schema.optionalKey(Schema.Array(groupSchema)),
  updatedAt: Schema.Finite,
})
const stateSchema = Schema.Record(Schema.String, entrySchema)

export type TerminalDrawerEntry = Schema.Schema.Type<typeof entrySchema>
export type TerminalDrawerState = Readonly<Record<string, TerminalDrawerEntry>>
export type TerminalDrawerPatch = Partial<Omit<TerminalDrawerEntry, 'updatedAt'>>
export type TerminalDrawerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** What a tab shows about its session; 'connecting' is renderer-only, the rest mirror server state. */
export type TerminalPaneStatus = 'connecting' | 'running' | 'exited' | 'failed' | 'ended'

/** Frames from the server, or a renderer-side status when the session cannot stream. */
export type TerminalSessionEvent =
  TerminalFrame | { readonly _tag: 'failed'; readonly message: string } | { readonly _tag: 'ended' }

/** Drawer state lives in the window's local storage. Absent or blocked storage means the drawer keeps no memory. */
export function browserTerminalStorage(): TerminalDrawerStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function defaultEntry(now: number): TerminalDrawerEntry {
  return {
    open: false,
    height: TERMINAL_DRAWER_DEFAULT_HEIGHT,
    terminals: null,
    activeTerminal: null,
    updatedAt: now,
  }
}

/** Expired and surplus entries are dropped, keeping the most recently edited Tasks. */
function prune(state: TerminalDrawerState, now: number): TerminalDrawerState {
  return Object.fromEntries(
    Object.entries(state)
      .filter(([, entry]) => now - entry.updatedAt <= TERMINAL_DRAWER_RETENTION_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, TERMINAL_DRAWER_MAX_TASKS),
  )
}

/** Reads every Task's drawer state. Malformed storage is reset, and storage errors yield an empty state. */
export function readTerminalDrawerState(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now = Date.now(),
): TerminalDrawerState {
  if (!storage) return {}
  try {
    const value = storage.getItem(STORAGE_KEY)
    if (!value) return {}
    const decoded = Schema.decodeUnknownOption(stateSchema)(JSON.parse(value))
    if (decoded._tag === 'None') {
      storage.setItem(STORAGE_KEY, '{}')
      return {}
    }
    const pruned = prune(decoded.value, now)
    if (Object.keys(pruned).length !== Object.keys(decoded.value).length)
      storage.setItem(STORAGE_KEY, JSON.stringify(pruned))
    return pruned
  } catch {
    return {}
  }
}

/** Merges a patch into one Task's entry and persists the result. The read is repeated so independent writers do not drop each other's fields. */
export function writeTerminalDrawerEntry(
  storage: TerminalDrawerStorage | null,
  taskId: string,
  patch: TerminalDrawerPatch,
  now = Date.now(),
): TerminalDrawerEntry {
  const current = readTerminalDrawerState(storage, now)
  const entry: TerminalDrawerEntry = { ...(current[taskId] ?? defaultEntry(now)), ...patch, updatedAt: now }
  const next = prune({ ...current, [taskId]: entry }, now)
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The drawer keeps working for this window when storage is unavailable.
  }
  return entry
}

/** The tabs a Task opens with: one terminal the first time its drawer is used. */
export function initialTerminalTabs(entry: TerminalDrawerEntry | undefined): {
  readonly terminals: ReadonlyArray<TerminalId>
  readonly active: TerminalId | null
} {
  if (!entry || entry.terminals === null) return { terminals: ['term-1'], active: 'term-1' }
  const terminals = entry.terminals.slice(0, TERMINAL_MAX_PER_TASK)
  const active =
    entry.activeTerminal !== null && terminals.includes(entry.activeTerminal)
      ? entry.activeTerminal
      : (terminals[0] ?? null)
  return { terminals, active }
}

/** The drawer's split groups and the focused terminal. Terminal order is the groups' order, flattened. */
export interface TerminalLayout {
  readonly groups: ReadonlyArray<TerminalGroup>
  readonly active: TerminalId | null
}

export function layoutTerminals(layout: TerminalLayout): ReadonlyArray<TerminalId> {
  return layout.groups.flatMap(group => group.terminals)
}

/**
 * The layout a Task opens with. Stored groups are kept when they name exactly the stored terminals;
 * otherwise, as for entries from before splits existed, each terminal gets a group of its own.
 */
export function initialTerminalLayout(entry: TerminalDrawerEntry | undefined): TerminalLayout {
  const { terminals, active } = initialTerminalTabs(entry)
  const stored = entry?.groups?.filter(group => group.terminals.length > 0)
  const storedIds = stored?.flatMap(group => group.terminals)
  const matches =
    storedIds !== undefined &&
    storedIds.length === terminals.length &&
    new Set(storedIds).size === storedIds.length &&
    storedIds.every(id => terminals.includes(id))
  const groups: ReadonlyArray<TerminalGroup> =
    matches && stored ? stored : terminals.map(id => ({ terminals: [id], direction: 'horizontal' as const }))
  return { groups, active }
}

/** Adds a terminal in a new group of its own and focuses it. */
export function addTerminalGroup(layout: TerminalLayout, id: TerminalId): TerminalLayout {
  return { groups: [...layout.groups, { terminals: [id], direction: 'horizontal' }], active: id }
}

/**
 * Splits the focused terminal's group: the new terminal goes right after the focused one and the whole
 * group takes the direction. With nothing focused it starts a group of its own.
 */
export function splitTerminal(
  layout: TerminalLayout,
  id: TerminalId,
  direction: TerminalSplitDirection,
): TerminalLayout {
  const index = layout.groups.findIndex(group => layout.active !== null && group.terminals.includes(layout.active))
  const group = layout.groups[index]
  if (!group || layout.active === null) return addTerminalGroup(layout, id)
  const terminals = [...group.terminals]
  terminals.splice(terminals.indexOf(layout.active) + 1, 0, id)
  const groups = layout.groups.map((item, itemIndex) => (itemIndex === index ? { terminals, direction } : item))
  return { groups, active: id }
}

/**
 * Removes a terminal and any group it leaves empty. When it was focused, the terminal that takes its
 * place in the flattened order is focused, or the one before it when it was last.
 */
export function removeTerminal(layout: TerminalLayout, id: TerminalId): TerminalLayout {
  const order = layoutTerminals(layout)
  const index = order.indexOf(id)
  if (index < 0) return layout
  const groups = layout.groups
    .map(group => ({ ...group, terminals: group.terminals.filter(terminal => terminal !== id) }))
    .filter(group => group.terminals.length > 0)
  const remaining = order.filter(terminal => terminal !== id)
  const active = layout.active === id ? (remaining[Math.min(index, remaining.length - 1)] ?? null) : layout.active
  return { groups, active }
}

/** The lowest unused terminal id, or null when the Task already has the maximum number of tabs. */
export function nextTerminalId(terminals: ReadonlyArray<TerminalId>): TerminalId | null {
  if (terminals.length >= TERMINAL_MAX_PER_TASK) return null
  return TERMINAL_IDS.find(id => !terminals.includes(id)) ?? null
}

/** Drawer height limits: at least 180px, at most 75% of the viewport and the container less 240px of chrome. */
export function terminalDrawerHeightBounds(viewportHeight: number, containerHeight: number) {
  const max = Math.max(
    TERMINAL_DRAWER_MIN_HEIGHT,
    Math.min(viewportHeight * TERMINAL_DRAWER_MAX_VIEWPORT_FRACTION, containerHeight - TERMINAL_DRAWER_CHROME_RESERVE),
  )
  return { min: TERMINAL_DRAWER_MIN_HEIGHT, max: Math.floor(max) }
}

export function clampTerminalDrawerHeight(height: number, viewportHeight: number, containerHeight: number): number {
  if (!Number.isFinite(height)) return TERMINAL_DRAWER_DEFAULT_HEIGHT
  const bounds = terminalDrawerHeightBounds(viewportHeight, containerHeight)
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, height)))
}

/**
 * Decides whether a stream frame advances the terminal. Snapshots always apply because they
 * replace the local buffer; other frames must be newer than the last applied sequence.
 */
export function acceptTerminalFrame(lastSequence: number | null, frame: TerminalFrame): boolean {
  if (frame._tag === 'snapshot') return true
  return lastSequence === null || frame.sequence > lastSequence
}

/** Terminal input is sent in pieces no larger than the server's write limit. */
export function terminalInputChunks(data: string, maxChars: number): string[] {
  const chunks: string[] = []
  let index = 0
  while (index < data.length) {
    let end = Math.min(index + maxChars, data.length)
    const last = data.charCodeAt(end - 1)
    // Never split a surrogate pair across two writes.
    if (end < data.length && last >= 0xd800 && last <= 0xdbff && end - 1 > index) end -= 1
    chunks.push(data.slice(index, end))
    index = end
  }
  return chunks
}

/** Transfers drawer and side-panel layouts with their live sessions after the first submission. */
export function transferTerminalDrawerState(
  storage: TerminalDrawerStorage | null,
  source: string,
  destination: string,
  current?: TerminalDrawerState,
): TerminalDrawerState {
  const state = current ?? readTerminalDrawerState(storage)
  const next: Record<string, TerminalDrawerEntry> = Object.fromEntries(
    Object.entries(state).map(([key, entry]) => {
      if (key !== source && !key.startsWith(`${source}::panel::`)) return [key, entry]
      return [`${destination}${key.slice(source.length)}`, entry]
    }),
  )
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* The in-memory state still transfers. */
  }
  return next
}
