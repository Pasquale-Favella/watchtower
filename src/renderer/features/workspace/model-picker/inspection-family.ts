import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/** Keyed atoms that stay in the registry for the window's session, so a result survives unmounting. */
export function keepAliveFamily<Key extends string, Member extends Atom.Atom<unknown>>(
  create: (key: Key) => Member,
): (key: Key) => Member {
  return Atom.family((key: Key) => Atom.keepAlive(create(key)))
}

export interface InspectionReading<Value> {
  /** The latest successful value. Kept while a refresh runs and after a later failure. */
  readonly value: Value | null
  readonly pending: boolean
  /** True only when there is a failure and no earlier value to show. */
  readonly failed: boolean
}

export function readInspection<Value, Error>(result: AsyncResult.AsyncResult<Value, Error>): InspectionReading<Value> {
  const value = Option.getOrNull(AsyncResult.value(result))
  return { value, pending: result.waiting, failed: result._tag === 'Failure' && value === null }
}
