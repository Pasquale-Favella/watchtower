import { createHash, randomUUID } from 'node:crypto'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { SideChatPersistence } from '@/core/application/commands/workspace-side-chats.js'
import {
  SIDE_CHAT_CONTEXT_MAX_CHARS,
  SideChatError,
  type SideChatRecord,
  sideChatRecordSchema,
} from '@/shared/schemas/workspace-side-chats.js'

const unavailable = () => new SideChatError({ code: 'unavailable', message: 'Side chat storage is unavailable.' })
/** Individual atomic receipts keep a retry bound to the exact parent snapshot captured on its first attempt. */
export const sideChatPersistenceLayer = (directory: string) =>
  Layer.effect(
    SideChatPersistence,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fileFor = (id: string) =>
        path.join(directory, `${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.json`)
      const read = Effect.fnUntraced(function* (file: string) {
        const stat = yield* fs.stat(file).pipe(Effect.mapError(unavailable))
        if (stat.type !== 'File' || stat.size > BigInt(SIDE_CHAT_CONTEXT_MAX_CHARS * 6 + 32768))
          return yield* unavailable()
        const raw = yield* fs.readFileString(file).pipe(Effect.mapError(unavailable))
        const value = yield* Effect.try({ try: () => JSON.parse(raw) as unknown, catch: unavailable })
        return yield* Schema.decodeUnknownEffect(sideChatRecordSchema)(value).pipe(Effect.mapError(unavailable))
      })
      return SideChatPersistence.of({
        get: id =>
          Effect.gen(function* () {
            const file = fileFor(id)
            if (!(yield* fs.exists(file).pipe(Effect.mapError(unavailable)))) return null
            const record = yield* read(file)
            if (record.binding.id !== id) return yield* unavailable()
            return record
          }),
        put: record =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unavailable))
            const temp = path.join(directory, `${randomUUID()}.tmp`)
            yield* fs.writeFileString(temp, JSON.stringify(record), { mode: 0o600 }).pipe(Effect.mapError(unavailable))
            yield* fs.rename(temp, fileFor(record.binding.id)).pipe(Effect.mapError(unavailable))
          }),
        list: () =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(directory).pipe(Effect.mapError(unavailable)))) return []
            const names = yield* fs.readDirectory(directory).pipe(Effect.mapError(unavailable))
            const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
            if (files.length > 2048) return yield* unavailable()
            const result: SideChatRecord[] = []
            for (const file of files) result.push(yield* read(path.join(directory, file)))
            return result
          }),
      })
    }),
  )
