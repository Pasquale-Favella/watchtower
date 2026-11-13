import { describe, expect, it } from 'vitest'

import {
  isTerminalDrawerShortcut,
  isTextEntryOutsideTerminal,
} from '@/renderer/features/workspace/terminal/terminal-keys.js'
import {
  acceptTerminalFrame,
  clampTerminalDrawerHeight,
  initialTerminalTabs,
  nextTerminalId,
  readTerminalDrawerState,
  TERMINAL_DRAWER_DEFAULT_HEIGHT,
  TERMINAL_DRAWER_MAX_TASKS,
  TERMINAL_DRAWER_RETENTION_MS,
  terminalDrawerHeightBounds,
  terminalInputChunks,
  transferTerminalDrawerState,
  writeTerminalDrawerEntry,
} from '@/renderer/features/workspace/terminal/terminal-storage.js'
import { TERMINAL_IDS, type TerminalFrame } from '@/shared/schemas/terminal.js'
import { taskIdSchema } from '@/shared/schemas/workspace.js'

const key = 'watchtower.workspace.terminal-drawer.v1'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(key, initial)
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
    removeItem: (name: string) => void values.delete(name),
    raw: () => values.get(key) ?? null,
  }
}

const taskA = taskIdSchema.make('task-a')
const taskB = taskIdSchema.make('task-b')

describe('terminal drawer persistence', () => {
  it('keeps height, open state and tabs per Task and merges patches without dropping other fields', () => {
    const storage = memoryStorage()
    writeTerminalDrawerEntry(storage, taskA, { open: true, height: 320 }, 100)
    writeTerminalDrawerEntry(storage, taskA, { terminals: ['term-1', 'term-2'], activeTerminal: 'term-2' }, 101)
    writeTerminalDrawerEntry(storage, taskB, { open: false }, 102)

    const state = readTerminalDrawerState(storage, 103)
    expect(state[taskA]).toEqual({
      open: true,
      height: 320,
      terminals: ['term-1', 'term-2'],
      activeTerminal: 'term-2',
      updatedAt: 101,
    })
    expect(state[taskB]).toMatchObject({ open: false, height: TERMINAL_DRAWER_DEFAULT_HEIGHT, terminals: null })
  })

  it('resets malformed storage instead of restoring invalid tabs', () => {
    const storage = memoryStorage(JSON.stringify({ [taskA]: { open: true, height: 300, terminals: ['term-9'] } }))
    expect(readTerminalDrawerState(storage, 1)).toEqual({})
    expect(storage.raw()).toBe('{}')
  })

  it('drops expired entries and keeps only the most recently edited Tasks', () => {
    const storage = memoryStorage()
    writeTerminalDrawerEntry(storage, 'expired', { open: true }, 0)
    for (let index = 0; index < TERMINAL_DRAWER_MAX_TASKS + 2; index++) {
      writeTerminalDrawerEntry(storage, `task-${index}`, { open: true }, TERMINAL_DRAWER_RETENTION_MS + index)
    }
    const now = TERMINAL_DRAWER_RETENTION_MS + TERMINAL_DRAWER_MAX_TASKS + 3
    const state = readTerminalDrawerState(storage, now)
    expect(Object.keys(state)).toHaveLength(TERMINAL_DRAWER_MAX_TASKS)
    expect(state.expired).toBeUndefined()
    expect(state[`task-${TERMINAL_DRAWER_MAX_TASKS + 1}`]).toBeDefined()
    expect(state['task-0']).toBeUndefined()
  })

  it('treats unavailable storage as an empty, working drawer', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => undefined,
    }
    expect(readTerminalDrawerState(broken, 1)).toEqual({})
    expect(writeTerminalDrawerEntry(broken, taskA, { open: true }, 2)).toMatchObject({ open: true })
  })
})

describe('terminal tabs and layout', () => {
  it('opens one terminal for a Task without stored tabs and restores the stored active tab', () => {
    expect(initialTerminalTabs(undefined)).toEqual({ terminals: ['term-1'], active: 'term-1' })
    expect(
      initialTerminalTabs({ open: true, height: 280, terminals: null, activeTerminal: null, updatedAt: 1 }),
    ).toEqual({ terminals: ['term-1'], active: 'term-1' })
    expect(
      initialTerminalTabs({
        open: true,
        height: 280,
        terminals: ['term-2', 'term-3'],
        activeTerminal: 'term-3',
        updatedAt: 1,
      }),
    ).toEqual({ terminals: ['term-2', 'term-3'], active: 'term-3' })
    expect(
      initialTerminalTabs({ open: true, height: 280, terminals: ['term-2'], activeTerminal: 'term-4', updatedAt: 1 }),
    ).toEqual({ terminals: ['term-2'], active: 'term-2' })
  })

  it('allocates the lowest free id across groups and stops at the owner limit', () => {
    expect(nextTerminalId([])).toBe('term-1')
    expect(nextTerminalId(['term-1', 'term-3'])).toBe('term-2')
    expect(nextTerminalId(['term-1', 'term-2', 'term-3'])).toBe('term-4')
    expect(nextTerminalId(['term-1', 'term-2', 'term-3', 'term-4'])).toBe('term-5')
    expect(nextTerminalId(TERMINAL_IDS)).toBeNull()
  })

  it('bounds height at 180px minimum and the lesser of 75% viewport or container minus chrome', () => {
    expect(terminalDrawerHeightBounds(1000, 2000)).toEqual({ min: 180, max: 750 })
    expect(terminalDrawerHeightBounds(1000, 500)).toEqual({ min: 180, max: 260 })
    expect(terminalDrawerHeightBounds(400, 300)).toEqual({ min: 180, max: 180 })
    expect(clampTerminalDrawerHeight(10, 1000, 2000)).toBe(180)
    expect(clampTerminalDrawerHeight(5000, 1000, 2000)).toBe(750)
    expect(clampTerminalDrawerHeight(Number.NaN, 1000, 2000)).toBe(TERMINAL_DRAWER_DEFAULT_HEIGHT)
    expect(clampTerminalDrawerHeight(299.6, 1000, 2000)).toBe(300)
  })
})

describe('terminal frame ordering', () => {
  const output = (sequence: number): TerminalFrame => ({ _tag: 'output', sequence, data: String(sequence) })
  const snapshot = (sequence: number): TerminalFrame => ({
    _tag: 'snapshot',
    sequence,
    status: 'running',
    exitCode: null,
    cols: 120,
    rows: 30,
    data: '',
  })

  it('drops output already covered by a snapshot and applies newer frames', () => {
    let last: number | null = null
    const applied: number[] = []
    for (const frame of [snapshot(5), output(4), output(5), output(6), output(6), output(7)]) {
      if (!acceptTerminalFrame(last, frame)) continue
      last = frame.sequence
      applied.push(frame.sequence)
    }
    expect(applied).toEqual([5, 6, 7])
  })

  it('always accepts a snapshot so a reattach replaces the local buffer', () => {
    expect(acceptTerminalFrame(9, snapshot(9))).toBe(true)
    expect(acceptTerminalFrame(9, output(8))).toBe(false)
    expect(acceptTerminalFrame(null, output(1))).toBe(true)
  })
})

describe('terminal input', () => {
  it('splits pasted text into writes no larger than the server limit without splitting a surrogate pair', () => {
    expect(terminalInputChunks('abcdef', 4)).toEqual(['abcd', 'ef'])
    const emoji = '😀😀'
    const chunks = terminalInputChunks(`a${emoji}`, 2)
    expect(chunks.join('')).toBe(`a${emoji}`)
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })
})

describe('terminal keyboard handling', () => {
  const keyEvent = (overrides: Partial<KeyboardEvent>) =>
    ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides }) as KeyboardEvent

  it('binds Mod+J with the platform modifier only', () => {
    expect(isTerminalDrawerShortcut(keyEvent({ ctrlKey: true }), false)).toBe(true)
    expect(isTerminalDrawerShortcut(keyEvent({ ctrlKey: true }), true)).toBe(false)
    expect(isTerminalDrawerShortcut(keyEvent({ metaKey: true }), true)).toBe(true)
    expect(isTerminalDrawerShortcut(keyEvent({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isTerminalDrawerShortcut(keyEvent({ ctrlKey: true, key: 'k' }), false)).toBe(false)
  })

  it('leaves text fields alone but not the terminal itself', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false }
    const input = { tagName: 'input', isContentEditable: false }
    const terminal = {
      tagName: 'TEXTAREA',
      isContentEditable: false,
      closest: (selector: string) => (selector === '.xterm' ? {} : null),
    }
    const button = { tagName: 'BUTTON', isContentEditable: false }
    expect(isTextEntryOutsideTerminal(textarea)).toBe(true)
    expect(isTextEntryOutsideTerminal(input)).toBe(true)
    expect(isTextEntryOutsideTerminal(terminal)).toBe(false)
    expect(isTextEntryOutsideTerminal(button)).toBe(false)
    expect(isTextEntryOutsideTerminal(null)).toBe(false)
  })
})

it('transfers drawer and panel layouts without storage access', () => {
  const drawer = {
    open: true,
    height: 320,
    terminals: ['term-1' as const],
    activeTerminal: 'term-1' as const,
    updatedAt: 1,
  }
  const panel = { ...drawer, terminals: ['term-2' as const], activeTerminal: 'term-2' as const }
  const result = transferTerminalDrawerState(null, 'draft-owner', 'task-owner', {
    'draft-owner': drawer,
    'draft-owner::panel::left': panel,
    'another-owner': drawer,
  })
  expect(result['draft-owner']).toBeUndefined()
  expect(result['task-owner']).toEqual(drawer)
  expect(result['task-owner::panel::left']).toEqual(panel)
  expect(result['another-owner']).toEqual(drawer)
})
