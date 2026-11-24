import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Schema from 'effect/Schema'
import { useCallback, useContext, useEffect, useState } from 'react'

import { TerminalRpcError } from '@/shared/rpc/terminal.js'
import {
  type TerminalId,
  type TerminalOwner,
  terminalOwnerKey,
  terminalTargetPayload,
} from '@/shared/schemas/terminal.js'

import { showErrorToast } from '../error-toast.js'
import { closeTerminalAtom, sendTerminalCommand } from './terminal-atoms.js'
import { takeTerminalCommand, useQueuedTerminalCommands } from './terminal-command-queue.js'
import {
  hydrateTerminalLayouts,
  type LayoutAction,
  ownerTerminalIds,
  terminalLayoutKey,
  terminalLayoutsAtom,
  updateTerminalLayoutAtom,
} from './terminal-layout-atoms.js'
import {
  initialTerminalLayout,
  layoutTerminals,
  nextTerminalId,
  TERMINAL_DRAWER_DEFAULT_HEIGHT,
  type TerminalPaneStatus,
  type TerminalSplitDirection,
} from './terminal-storage.js'

/** Shared owner allocation prevents drawer and side-panel shells from sharing a terminal id. */
export function useTerminalTabs(owner: TerminalOwner, groupId = 'drawer') {
  const registry = useContext(RegistryContext)
  const ownerKey = terminalOwnerKey(owner)
  const key = terminalLayoutKey(ownerKey, groupId)
  const entries = useAtomValue(terminalLayoutsAtom)
  const update = useAtomSet(updateTerminalLayoutAtom)
  const closeTerminal = useAtomSet(closeTerminalAtom, { mode: 'promise' })
  const [statuses, setStatuses] = useState<Partial<Record<TerminalId, TerminalPaneStatus>>>({})
  const [preview, setPreview] = useState<number | null>(null)
  useEffect(() => {
    hydrateTerminalLayouts(registry)
    registry.set(updateTerminalLayoutAtom, { ownerKey, groupId, action: { kind: 'init' } })
  }, [groupId, ownerKey, registry])
  const entry = entries[key]
  const layout = initialTerminalLayout(
    entry ?? { open: false, height: TERMINAL_DRAWER_DEFAULT_HEIGHT, terminals: [], activeTerminal: null, updatedAt: 0 },
  )
  const terminals = layoutTerminals(layout)
  const command = (action: LayoutAction) => update({ ownerKey, groupId, action })
  const create = () => {
    command({ kind: 'create' })
    return registry.get(terminalLayoutsAtom)[key]?.activeTerminal ?? null
  }
  const split = (direction: TerminalSplitDirection) => {
    command({ kind: 'split', direction })
    return registry.get(terminalLayoutsAtom)[key]?.activeTerminal ?? null
  }
  const close = async (id: TerminalId): Promise<void> => {
    if (!terminals.includes(id)) return
    try {
      await closeTerminal({ ...terminalTargetPayload(owner), terminalId: id })
      command({ kind: 'close', id })
    } catch (cause) {
      if (Schema.is(TerminalRpcError)(cause) && cause.code === 'not-found') command({ kind: 'close', id })
      else
        showErrorToast(
          'workspace:terminal:close',
          "Couldn't close terminal",
          'Could not close this terminal. Try again.',
        )
    }
  }
  const reportStatus = useCallback((id: TerminalId, status: TerminalPaneStatus) => {
    setStatuses(previous => (previous[id] === status ? previous : { ...previous, [id]: status }))
  }, [])
  const queuedCommands = useQueuedTerminalCommands(ownerKey)
  useEffect(() => {
    const next = groupId === 'drawer' ? queuedCommands[0] : undefined
    if (next === undefined) return
    const target = layout.active === null ? null : statuses[layout.active]
    if (terminals.length === 0 || target === 'exited') {
      if (nextTerminalId(ownerTerminalIds(entries, ownerKey)) !== null) create()
      return
    }
    if (layout.active === null || target !== 'running') return
    const data = next.replace(/\r?\n/g, '\r') + '\r'
    if (sendTerminalCommand(owner, layout.active, { _tag: 'write', data })) takeTerminalCommand(ownerKey)
  }, [create, entries, groupId, layout.active, owner, ownerKey, queuedCommands, statuses, terminals])

  return {
    terminals,
    canCreate: nextTerminalId(ownerTerminalIds(entries, ownerKey)) !== null,
    groups: layout.groups,
    active: layout.active,
    height: preview ?? entry?.height ?? TERMINAL_DRAWER_DEFAULT_HEIGHT,
    statuses,
    select: (id: TerminalId) => command({ kind: 'select', id }),
    create,
    split,
    close,
    previewHeight: setPreview,
    commitHeight: (height: number) => {
      setPreview(null)
      command({ kind: 'height', height })
    },
    reportStatus,
  }
}
