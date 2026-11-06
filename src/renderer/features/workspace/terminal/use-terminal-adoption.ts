import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Schema from 'effect/Schema'
import { useContext, useEffect } from 'react'

import { TerminalRpcError } from '@/shared/rpc/terminal.js'
import { type DraftTerminalTarget, terminalOwnerKey } from '@/shared/schemas/terminal.js'
import type { TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { adoptDraftTerminalsAtom } from './terminal-atoms.js'
import { hydrateTerminalLayouts, ownerTerminalIds, terminalLayoutsAtom } from './terminal-layout-atoms.js'
import {
  hydrateRetainedTerminalOwners,
  retainDraftTerminalOwnerAtom,
  retainedTerminalOwnersAtom,
} from './terminal-owner-atoms.js'
import { browserTerminalStorage, transferTerminalDrawerState } from './terminal-storage.js'

export function useRetainedTaskTerminalTarget(taskId: TaskId): DraftTerminalTarget | undefined {
  const registry = useContext(RegistryContext)
  const owners = useAtomValue(retainedTerminalOwnersAtom)
  useEffect(() => {
    hydrateRetainedTerminalOwners(registry)
    hydrateTerminalLayouts(registry)
  }, [registry])
  return owners[taskId]
}

/** A checkout change retains the original shells under their original draft owner. */
export function useTerminalAdoption() {
  const registry = useContext(RegistryContext)
  const adopt = useAtomSet(adoptDraftTerminalsAtom, { mode: 'promise' })
  return {
    drawerState: (draft: DraftTerminalTarget) => registry.get(terminalLayoutsAtom)[terminalOwnerKey(draft)],
    adopt: async (draft: DraftTerminalTarget, taskId: TaskId, checkoutId?: WorkspaceCheckoutId): Promise<boolean> => {
      hydrateTerminalLayouts(registry)
      if (ownerTerminalIds(registry.get(terminalLayoutsAtom), terminalOwnerKey(draft)).length === 0) return true
      try {
        await adopt({ draft, taskId, ...(checkoutId ? { checkoutId } : {}) })
        hydrateTerminalLayouts(registry)
        registry.set(
          terminalLayoutsAtom,
          transferTerminalDrawerState(
            browserTerminalStorage(),
            terminalOwnerKey(draft),
            taskId,
            registry.get(terminalLayoutsAtom),
          ),
        )
        return true
      } catch (error) {
        if (!Schema.is(TerminalRpcError)(error) || error.code !== 'conflict') throw error
        registry.set(retainDraftTerminalOwnerAtom, { taskId, draft })
        return false
      }
    },
  }
}
