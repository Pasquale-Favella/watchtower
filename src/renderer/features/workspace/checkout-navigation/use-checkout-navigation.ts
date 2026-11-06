import { useAtomSet } from '@effect/atom-react'
import * as Schema from 'effect/Schema'
import { useEffect, useRef, useState } from 'react'

import { type CheckoutEditor, checkoutEditorSchema } from '@/shared/rpc/checkout-navigation.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { openCheckoutFileAtom, revealCheckoutFileAtom } from './atoms.js'

const EDITOR_STORAGE_KEY = 'watchtower.workspace.file-editor.v1'

export function useOpenCheckoutFile() {
  return useAtomSet(openCheckoutFileAtom, { mode: 'promise' })
}

function readEditor(): CheckoutEditor {
  try {
    const saved = localStorage.getItem(EDITOR_STORAGE_KEY)
    return Schema.is(checkoutEditorSchema)(saved) ? saved : 'vscode'
  } catch {
    return 'vscode'
  }
}

export function useCheckoutNavigation(scope: CheckoutScope, path: string | null) {
  const openFile = useAtomSet(openCheckoutFileAtom, { mode: 'promise' })
  const revealFile = useAtomSet(revealCheckoutFileAtom, { mode: 'promise' })
  const [editor, setEditor] = useState(readEditor)
  const [failure, setFailure] = useState<{ readonly identity: string; readonly message: string } | null>(null)
  const [pending, setPending] = useState(false)
  const locked = useRef(false)
  const commands = useRef({ openFile, revealFile })
  const identity = JSON.stringify([scope.projectId, scope.checkoutId ?? null, path])
  useEffect(() => {
    commands.current = { openFile, revealFile }
  })
  async function run(operation: () => Promise<void>): Promise<boolean> {
    if (!path || locked.current) return false
    locked.current = true
    setPending(true)
    setFailure(null)
    try {
      await operation()
      return true
    } catch (cause) {
      setFailure({ identity, message: cause instanceof Error ? cause.message : 'Could not open this file.' })
      return false
    } finally {
      locked.current = false
      setPending(false)
    }
  }
  return {
    editor,
    pending,
    error: failure?.identity === identity ? failure.message : null,
    open: async (selected: CheckoutEditor = editor): Promise<boolean> => {
      if (!path) return false
      setEditor(selected)
      try {
        localStorage.setItem(EDITOR_STORAGE_KEY, selected)
      } catch {
        /* The choice remains available in this window. */
      }
      return run(() => commands.current.openFile({ ...scope, path, editor: selected }))
    },
    reveal: async (): Promise<boolean> => (path ? run(() => commands.current.revealFile({ ...scope, path })) : false),
  }
}
