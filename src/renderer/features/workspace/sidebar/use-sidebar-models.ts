import { useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import { useMemo } from 'react'

import { connectionInspectionAtom } from '../connection-atoms.js'
import { catalogView, knownModels, type ModelChoice } from '../model-picker/catalog.js'
import { readInspection } from '../model-picker/inspection-family.js'

export function useSidebarModels(connectionIds: readonly string[]): ReadonlyMap<string, readonly ModelChoice[]> {
  const modelsByConnection = useMemo(
    () =>
      Atom.readable(get => {
        const models = new Map<string, readonly ModelChoice[]>()
        for (const id of connectionIds) {
          const reading = readInspection(get(connectionInspectionAtom(id)))
          const catalog = knownModels(catalogView({ inspection: reading.value, failed: reading.failed }))
          if (catalog) models.set(id, catalog)
        }
        return models
      }),
    [connectionIds],
  )
  return useAtomValue(modelsByConnection)
}
