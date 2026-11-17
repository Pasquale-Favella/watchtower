import * as Cause from 'effect/Cause'
import type * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

export type WorkspaceOperation<Input, Value, Error> = () => Atom.AtomResultFn<Input, Value, Error>

/** Each caller owns its result and lifetime; the runtime and RPC connection stay shared. */
export async function runWorkspaceOperation<Input, Value, Error>(
  registry: AtomRegistry.AtomRegistry,
  makeAtom: WorkspaceOperation<Input, Value, Error>,
  request: Input,
): Promise<Value> {
  const atom = makeAtom()
  const unmount = registry.mount(atom)
  try {
    registry.set(atom, request)
    return await new Promise<Value>((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      unsubscribe = registry.subscribe(
        atom,
        result => {
          if (result.waiting || result._tag === 'Initial') return
          settled = true
          unsubscribe()
          if (result._tag === 'Success') resolve(result.value)
          else reject(Cause.squash(result.cause))
        },
        { immediate: true },
      )
      // Synchronous operations can settle before subscribe returns its release function.
      if (settled) unsubscribe()
    })
  } finally {
    unmount()
  }
}
