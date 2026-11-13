import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { useContext, useEffect } from 'react'

import { type DraftTerminalTarget, terminalOwnerKey, type TerminalTarget } from '@/shared/schemas/terminal.js'

import { hydrateTerminalLayouts, terminalLayoutKey, terminalLayoutsAtom } from './terminal-layout-atoms.js'
import type { TerminalDrawerState } from './terminal-storage.js'

export const PREVIOUS_CHECKOUT_DRAWER = 'previous-checkout-drawer'

export function terminalGroupContext(
  layouts: TerminalDrawerState,
  target: TerminalTarget,
  retained: DraftTerminalTarget | undefined,
  resourceId: string,
): { readonly target: TerminalTarget; readonly groupId: string; readonly previousCheckout: boolean } {
  const groupId = resourceId === PREVIOUS_CHECKOUT_DRAWER ? 'drawer' : resourceId
  if (retained && layouts[terminalLayoutKey(terminalOwnerKey(retained), groupId)])
    return { target: retained, groupId, previousCheckout: true }
  return { target, groupId: resourceId, previousCheckout: false }
}

export function useTerminalGroupContext(target: TerminalTarget, retained?: DraftTerminalTarget) {
  const registry = useContext(RegistryContext)
  const layouts = useAtomValue(terminalLayoutsAtom)
  useEffect(() => hydrateTerminalLayouts(registry), [registry])
  return (resourceId: string) => terminalGroupContext(layouts, target, retained, resourceId)
}
