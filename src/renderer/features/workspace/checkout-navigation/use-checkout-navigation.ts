import { useAtomSet } from '@effect/atom-react'
import * as Schema from 'effect/Schema'
import { useEffect, useRef, useState } from 'react'

import { type CheckoutEditor, checkoutEditorSchema } from '@/shared/rpc/checkout-navigation.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { showErrorToast } from '../error-toast.js'
import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { downloadCheckoutFileAtom, openCheckoutFileAtom, revealCheckoutFileAtom } from './atoms.js'

/** One toast slot for open, reveal and download, so a repeated failure updates the visible toast. */
const CHECKOUT_NAVIGATION_TOAST_ID = 'workspace:checkout:navigation'
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
  const downloadFile = useWorkspaceOperation(downloadCheckoutFileAtom)
  const openFile = useAtomSet(openCheckoutFileAtom, { mode: 'promise' })
  const revealFile = useAtomSet(revealCheckoutFileAtom, { mode: 'promise' })
  const [editor, setEditor] = useState(readEditor)
  const [pending, setPending] = useState(false)
  const locked = useRef(false)
  const commands = useRef({ openFile, revealFile })
  useEffect(() => {
    commands.current = { openFile, revealFile }
  })
  async function run(title: string, operation: () => Promise<void>): Promise<boolean> {
    if (!path || locked.current) return false
    locked.current = true
    setPending(true)
    try {
      await operation()
      return true
    } catch (cause) {
      showErrorToast(
        CHECKOUT_NAVIGATION_TOAST_ID,
        title,
        cause instanceof Error ? cause.message : 'Could not open this file.',
      )
      return false
    } finally {
      locked.current = false
      setPending(false)
    }
  }
  return {
    download: async (): Promise<boolean> =>
      path
        ? run("Couldn't download file", async () => {
            await downloadFile({ ...scope, path })
          })
        : false,
    editor,
    pending,
    open: async (selected: CheckoutEditor = editor): Promise<boolean> => {
      if (!path) return false
      setEditor(selected)
      try {
        localStorage.setItem(EDITOR_STORAGE_KEY, selected)
      } catch {
        /* The choice remains available in this window. */
      }
      return run("Couldn't open file", () => commands.current.openFile({ ...scope, path, editor: selected }))
    },
    reveal: async (): Promise<boolean> =>
      path ? run("Couldn't reveal file", () => commands.current.revealFile({ ...scope, path })) : false,
  }
}
