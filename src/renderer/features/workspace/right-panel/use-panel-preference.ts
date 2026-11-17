import { useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import * as Schema from 'effect/Schema'
import { useCallback } from 'react'

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

const preferences = Atom.family((key: string) => Atom.keepAlive(Atom.make<unknown>(read(key))))

function usePreference(key: string): readonly [unknown, (value: unknown) => void] {
  const atom = preferences(key)
  const value = useAtomValue(atom)
  const update = useAtomSet(atom)
  const set = useCallback(
    (next: unknown) => {
      update(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* Keep the window's preference. */
      }
    },
    [key, update],
  )
  return [value, set]
}

export function usePanelBoolean(key: string, defaultValue: boolean): readonly [boolean, (value: boolean) => void] {
  const [value, set] = usePreference(key)
  return [Schema.is(Schema.Boolean)(value) ? value : defaultValue, set]
}

export function usePanelString<Value extends string>(
  key: string,
  defaultValue: Value,
  allowed: readonly Value[],
): readonly [Value, (value: Value) => void] {
  const [value, set] = usePreference(key)
  return [Schema.is(Schema.String)(value) && allowed.includes(value as Value) ? (value as Value) : defaultValue, set]
}

export function usePanelNumber(key: string, defaultValue: number): readonly [number, (value: number) => void] {
  const [value, set] = usePreference(key)
  return [Schema.is(Schema.Number)(value) && Number.isFinite(value) ? value : defaultValue, set]
}
