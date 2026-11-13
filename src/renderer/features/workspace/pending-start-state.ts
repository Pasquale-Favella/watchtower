import * as Schema from 'effect/Schema'

import { workspaceStartRunRequestSchema } from '@/shared/rpc/workspace.js'
import { WORKSPACE_PROMPT_MAX_LENGTH } from '@/shared/schemas/prompt-context.js'
import { conversationIdSchema } from '@/shared/schemas/workspace.js'

export const PENDING_START_MAX_CONVERSATIONS = 40
export const PENDING_START_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
export const PENDING_START_MAX_PROMPT_LENGTH = WORKSPACE_PROMPT_MAX_LENGTH
const STORAGE_KEY = 'watchtower.workspace.pending-starts.v1'

const pendingStartRecordSchema = Schema.Struct({
  conversationId: conversationIdSchema,
  command: workspaceStartRunRequestSchema,
  rawDraft: Schema.String,
  state: Schema.Literals(['pending', 'uncertain']),
  updatedAt: Schema.Number.check(Schema.isFinite()),
})
const pendingStartRecordsSchema = Schema.Record(Schema.String, pendingStartRecordSchema)

export type PendingStartRecord = Schema.Schema.Type<typeof pendingStartRecordSchema>
export type PendingStartCommand = Schema.Schema.Type<typeof workspaceStartRunRequestSchema>
export type PendingStartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface PendingStartStore {
  readonly records: Readonly<Record<string, PendingStartRecord>>
  readonly error: string | null
}

export const emptyPendingStartStore: PendingStartStore = { records: {}, error: null }

export const canClearCapturedDraft = (currentDraft: string, capturedDraft: string): boolean =>
  currentDraft === capturedDraft

function persist(
  storage: PendingStartStorage | null,
  records: Readonly<Record<string, PendingStartRecord>>,
): string | null {
  if (!storage) return 'Persistent storage is unavailable. Run delivery is blocked.'
  try {
    if (Object.keys(records).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(records))
    return null
  } catch {
    return 'Pending Run intent could not be saved. A Run was not started.'
  }
}

export function readPendingStartStore(storage: PendingStartStorage | null, now = Date.now()): PendingStartStore {
  if (!storage) return { records: {}, error: 'Persistent storage is unavailable. Run delivery is blocked.' }
  let stored: string | null
  try {
    stored = storage.getItem(STORAGE_KEY)
  } catch {
    return { records: {}, error: 'Pending Run intents could not be read. Sending is blocked.' }
  }
  if (!stored) return emptyPendingStartStore

  let decoded: PendingStartStore['records']
  try {
    const result = Schema.decodeUnknownOption(pendingStartRecordsSchema)(JSON.parse(stored))
    if (result._tag === 'None')
      return { records: {}, error: 'Stored pending Run intent data is invalid. Sending is blocked.' }
    decoded = result.value
  } catch {
    return { records: {}, error: 'Stored pending Run intent data is invalid. Sending is blocked.' }
  }

  const entries = Object.entries(decoded)
  if (entries.length > PENDING_START_MAX_CONVERSATIONS)
    return {
      records: {},
      error: 'Pending Run intent storage is over its limit. Resolve existing intents before sending.',
    }
  for (const [key, record] of entries) {
    if (
      key !== record.conversationId ||
      record.command.conversationId !== record.conversationId ||
      record.command.prompt.length > PENDING_START_MAX_PROMPT_LENGTH ||
      record.rawDraft.length > PENDING_START_MAX_PROMPT_LENGTH
    )
      return { records: {}, error: 'Stored pending Run intent data failed validation. Sending is blocked.' }
  }

  const records = Object.fromEntries(entries.map(([key, record]) => [key, { ...record, state: 'uncertain' as const }]))
  const error = entries.some(([, record]) => record.state === 'pending') ? persist(storage, records) : null
  const expired = entries.some(([, record]) => now - record.updatedAt > PENDING_START_RETENTION_MS)
  return {
    records,
    error:
      error ??
      (expired
        ? 'An unresolved Run intent is older than 60 days. Retry that exact command before starting new work.'
        : null),
  }
}

export function capturePendingStart(
  storage: PendingStartStorage | null,
  store: PendingStartStore,
  input: {
    readonly conversationId: PendingStartRecord['conversationId']
    readonly command: unknown
    readonly rawDraft: string
  },
  now = Date.now(),
): PendingStartStore {
  const command = Schema.decodeUnknownOption(workspaceStartRunRequestSchema)(input.command)
  if (command._tag === 'None' || command.value.conversationId !== input.conversationId)
    return { ...store, error: 'Pending Run intent does not match this Conversation. Sending is blocked.' }
  if (
    command.value.prompt.length > PENDING_START_MAX_PROMPT_LENGTH ||
    input.rawDraft.length > PENDING_START_MAX_PROMPT_LENGTH
  )
    return { ...store, error: 'This prompt exceeds the 12,000 character pending Run limit.' }
  const previous = store.records[input.conversationId]
  if (previous) {
    if (previous.command.commandId === command.value.commandId) {
      const sameCommand = JSON.stringify(previous.command) === JSON.stringify(command.value)
      if (!sameCommand || previous.rawDraft !== input.rawDraft)
        return { ...store, error: 'A retry must use the original pending Run payload and draft.' }
      if (previous.state === 'pending') return store
      const records = {
        ...store.records,
        [input.conversationId]: { ...previous, state: 'pending' as const, updatedAt: now },
      }
      const error = persist(storage, records)
      return error ? { ...store, error } : { records, error: null }
    }
    return { ...store, error: 'This Conversation has an unresolved Run intent. Retry that exact command first.' }
  }
  if (store.error) return store
  if (Object.keys(store.records).length >= PENDING_START_MAX_CONVERSATIONS)
    return {
      ...store,
      error: 'The 40 pending Run intent limit is full. Resolve an existing intent before starting another Run.',
    }

  const record: PendingStartRecord = {
    conversationId: input.conversationId,
    command: command.value,
    rawDraft: input.rawDraft,
    state: 'pending',
    updatedAt: now,
  }
  const records = { ...store.records, [input.conversationId]: record }
  const error = persist(storage, records)
  return error ? { ...store, error } : { records, error: null }
}

export function markPendingStartUncertain(
  storage: PendingStartStorage | null,
  store: PendingStartStore,
  conversationId: PendingStartRecord['conversationId'],
  commandId: string,
  now = Date.now(),
): PendingStartStore {
  const record = store.records[conversationId]
  if (!record || record.command.commandId !== commandId) return store
  const records = { ...store.records, [conversationId]: { ...record, state: 'uncertain' as const, updatedAt: now } }
  const error = persist(storage, records)
  return { records, error }
}

export function clearPendingStart(
  storage: PendingStartStorage | null,
  store: PendingStartStore,
  conversationId: PendingStartRecord['conversationId'],
  commandId: string,
): PendingStartStore {
  const record = store.records[conversationId]
  if (!record || record.command.commandId !== commandId) return store
  const records = Object.fromEntries(Object.entries(store.records).filter(([key]) => key !== conversationId))
  const error = persist(storage, records)
  return error
    ? {
        records: { ...store.records, [conversationId]: { ...record, state: 'uncertain' } },
        error,
      }
    : { records, error: null }
}
