import { RegistryContext } from '@effect/atom-react'
import { useContext } from 'react'

import { type TerminalOwner, terminalOwnerKey, terminalTargetPayload } from '@/shared/schemas/terminal.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { listTerminalsAtom, makeCloseTerminalAtom } from './terminal-atoms.js'
import {
  hydrateTerminalLayouts,
  terminalLayoutKey,
  terminalLayoutsAtom,
  updateTerminalLayoutAtom,
} from './terminal-layout-atoms.js'

export function useTerminalGroupActions() {
  const registry = useContext(RegistryContext)
  const close = useWorkspaceOperation(makeCloseTerminalAtom)
  const list = useWorkspaceOperation(listTerminalsAtom)
  const ids = (target: TerminalOwner, groupId: string) => {
    hydrateTerminalLayouts(registry)
    return registry.get(terminalLayoutsAtom)[terminalLayoutKey(terminalOwnerKey(target), groupId)]?.terminals ?? []
  }
  return {
    hasRunning: async (target: TerminalOwner, groupId: string): Promise<boolean> => {
      const terminals = ids(target, groupId)
      const result = await list(terminalTargetPayload(target))
      return result.items.some(item => terminals.includes(item.terminalId) && item.status === 'running')
    },
    closeGroup: async (target: TerminalOwner, groupId: string): Promise<void> => {
      const terminals = [...ids(target, groupId)]
      for (const id of terminals) {
        await close({ ...terminalTargetPayload(target), terminalId: id })
        registry.set(updateTerminalLayoutAtom, {
          ownerKey: terminalOwnerKey(target),
          groupId,
          action: { kind: 'close', id },
        })
      }
    },
  }
}
