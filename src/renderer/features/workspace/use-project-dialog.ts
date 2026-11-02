import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { workspaceProjectDialogNoticeAtom, workspaceProjectDialogOpenAtom } from './project-dialog-atoms.js'

export function useWorkspaceProjectDialog() {
  const isOpen = useAtomValue(workspaceProjectDialogOpenAtom)
  const notice = useAtomValue(workspaceProjectDialogNoticeAtom)
  const setOpen = useAtomSet(workspaceProjectDialogOpenAtom)
  const setNotice = useAtomSet(workspaceProjectDialogNoticeAtom)

  return {
    isOpen,
    notice,
    open: () => {
      setNotice(null)
      setOpen(true)
    },
    close: () => setOpen(false),
    showNotice: (value: string) => setNotice(value),
  }
}
