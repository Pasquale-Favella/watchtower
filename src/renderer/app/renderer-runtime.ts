import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import type { OverviewPeriod } from '../../shared/schemas/overview.js'
import { periodAtom } from '../stores/atoms/scope.js'

export interface RendererRuntimeOwner {
  readonly registry: AtomRegistry.AtomRegistry
  readonly runtime: Atom.RegistryRuntimeFactory
  readonly dispose: () => void
}

export interface RendererRuntimeOptions {
  readonly initialPeriod?: OverviewPeriod
}

/** Creates one independent Atom registry and runtime factory for a renderer isolate. */
export const createRendererRuntimeOwner = (options: RendererRuntimeOptions = {}): RendererRuntimeOwner => {
  const initialPeriod = options.initialPeriod ?? 'today'
  const registry = AtomRegistry.make({ initialValues: [[periodAtom, initialPeriod]] })
  const runtime = Atom.context()
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    registry.dispose()
  }

  return { registry, runtime, dispose }
}

/** Each renderer root may seed its transient Scope from hydrated preferences before rendering. */
export const rendererRuntimeOwner = createRendererRuntimeOwner()
export const registry = rendererRuntimeOwner.registry
export const runtime = rendererRuntimeOwner.runtime

// A runtime replacement resets every module-level descriptor through a full page reload.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    rendererRuntimeOwner.dispose()
    window.location.reload()
  })
}
