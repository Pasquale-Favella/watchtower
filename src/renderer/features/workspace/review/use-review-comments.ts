import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import * as Schema from 'effect/Schema'
import { useContext, useEffect } from 'react'

import { type ReviewComment, withoutCapturedReviewComments } from './review-comments.js'
import { ReviewOwnerContext } from './review-context.js'

const STORAGE_KEY = 'watchtower.workspace.review-comments.v1'
const commentSchema = Schema.Struct({
  id: Schema.String,
  sectionId: Schema.String,
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  side: Schema.optional(Schema.Literals(['additions', 'deletions'])),
  endSide: Schema.optional(Schema.Literals(['additions', 'deletions'])),
  text: Schema.String,
  snippet: Schema.String,
  language: Schema.String,
  source: Schema.optional(Schema.Literals(['file', 'diff'])),
})
const storageSchema = Schema.Record(Schema.String, Schema.Array(commentSchema))
type Entries = Readonly<Record<string, readonly ReviewComment[]>>
const entriesAtom = Atom.keepAlive(Atom.make<Entries>({}))
const hydrated = new WeakSet<object>()
const EMPTY_COMMENTS: readonly ReviewComment[] = []

export function useReviewComments(ownerKey?: string) {
  const inherited = useContext(ReviewOwnerContext)
  const key = ownerKey ?? inherited
  const registry = useContext(RegistryContext)
  const entries = useAtomValue(entriesAtom)
  useEffect(() => {
    if (hydrated.has(registry)) return
    hydrated.add(registry)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const decoded = Schema.decodeUnknownOption(storageSchema)(JSON.parse(raw))
      if (decoded._tag === 'Some') registry.set(entriesAtom, decoded.value)
    } catch {
      /* Comments remain available in this window when storage is unavailable. */
    }
  }, [registry])

  function write(target: string, items: readonly ReviewComment[]): void {
    const next = { ...registry.get(entriesAtom), [target]: items }
    registry.set(entriesAtom, next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* A failed storage write must not discard the active draft. */
    }
  }
  function clearIn(target: string, captured: readonly ReviewComment[]): void {
    write(target, withoutCapturedReviewComments(registry.get(entriesAtom)[target] ?? [], captured))
  }
  return {
    ownerKey: key,
    items: entries[key] ?? EMPTY_COMMENTS,
    upsert: (comment: ReviewComment) => {
      const current = registry.get(entriesAtom)[key] ?? []
      const index = current.findIndex(item => item.id === comment.id)
      if (index < 0) write(key, [...current, comment])
      else
        write(
          key,
          current.map(item => (item.id === comment.id ? comment : item)),
        )
    },
    remove: (id: string) =>
      write(
        key,
        (registry.get(entriesAtom)[key] ?? []).filter(item => item.id !== id),
      ),
    clearCaptured: (captured: readonly ReviewComment[]) => clearIn(key, captured),
    clearIn,
    copyTo: (target: string, items: readonly ReviewComment[]) => {
      const current = registry.get(entriesAtom)[target] ?? []
      const ids = new Set(current.map(item => item.id))
      write(target, [...current, ...items.filter(item => !ids.has(item.id))])
    },
  }
}
