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

const entrySchema = Schema.Struct({
  open: Schema.Boolean,
  height: Schema.Finite,
  /** null until the Task first records its tabs, so a drawer opened without tabs still opens one terminal. */
  terminals: Schema.NullOr(Schema.Array(terminalIdSchema)),
  activeTerminal: Schema.NullOr(terminalIdSchema),
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
