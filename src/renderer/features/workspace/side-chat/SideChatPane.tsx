import { ArrowUpRight, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { SideChatBinding } from '@/shared/schemas/workspace-side-chats.js'

import { useOpenCheckoutFile } from '../checkout-navigation/use-checkout-navigation.js'
import { isRunActive } from '../composer-state.js'
import { useWorkspaceTask, useWorkspaceTaskSnapshot } from '../hooks.js'
import { WorkspaceComposer } from '../WorkspaceComposer.js'
import { WorkspaceConversation } from '../WorkspaceConversation.js'
import { useBringBackSideChat, useSideChatBinding, useSideChatPreferences } from './hooks.js'
import { WorkspaceQueryScopeContext } from './scope-context.js'
import { useSideChatQueryScope } from './use-side-chat-query-scope.js'

export interface SideChatPaneProps {
  readonly id: string
  readonly visible?: boolean | undefined
  readonly onOpenAsChat: (binding: SideChatBinding) => void
  readonly onClose: () => void
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly fileCheckoutId?: WorkspaceCheckoutId | undefined
}
export function SideChatPane(props: SideChatPaneProps): React.JSX.Element {
  const binding = useSideChatBinding(props.id)
  const scope = useSideChatQueryScope()
  if (binding.error)
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        {binding.error}
      </p>
    )
  if (!binding.data)
    return (
      <p role="status" className="p-4 text-sm">
        Loading side chat...
      </p>
    )
  return (
    <WorkspaceQueryScopeContext value={scope}>
      <SideChatContent {...props} binding={binding.data} />
    </WorkspaceQueryScopeContext>
  )
}
function SideChatContent({
  binding,
  onOpenAsChat,
  onClose,
  visible = true,
  onOpenFile,
  fileCheckoutId,
}: SideChatPaneProps & { readonly binding: SideChatBinding }): React.JSX.Element {
  const detail = useWorkspaceTask({ taskId: binding.taskId, options: { limit: 30 } })
  const snapshot = useWorkspaceTaskSnapshot({ taskId: binding.taskId, runLimit: 100 })
  const sideBusy = snapshot.data?.runs.some(isRunActive) ?? false
  const completed = snapshot.data?.runs.some(run => run.status === 'completed') ?? false
  const back = useBringBackSideChat(binding.parentConversationId)
  const [selection, setSelection] = useState('')
  const [broughtBack, setBroughtBack] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const openFile = useOpenCheckoutFile()
  const runContext = snapshot.data?.runContexts?.find(context => context.conversationId === binding.conversationId)
  const activeCheckoutId = runContext?.checkoutId ?? binding.checkoutId
  function openChatFile(path: string): void {
    setFileError(null)
    if (onOpenFile && activeCheckoutId === fileCheckoutId) {
      onOpenFile(path)
      return
    }
    if (!detail.data) return
    void openFile({
      projectId: detail.data.task.projectId,
      checkoutId: activeCheckoutId,
      path,
      editor: 'vscode',
    }).catch(() => setFileError('Could not open this file.'))
  }
  const bringBackLabel = selection ? 'Bring selection back' : 'Bring back'
  useSideChatPreferences(binding.parentConversationId, binding.conversationId, binding.checkoutId)
  return (
    <section
      aria-label="Side chat"
      aria-hidden={!visible}
      inert={!visible}
      style={!visible ? { display: 'none' } : undefined}
      className="flex h-full min-h-0 flex-col"
      onPointerUp={event => {
        const selected = window.getSelection()
        if (
          selected?.anchorNode &&
          selected.focusNode &&
          event.currentTarget.contains(selected.anchorNode) &&
          event.currentTarget.contains(selected.focusNode)
        )
          setSelection(selected.toString().trim())
      }}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{binding.title}</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={back.pending || (!selection && (sideBusy || !completed))}
          onClick={() => void back.bringBack(binding.id, selection || undefined).then(setBroughtBack)}
          title="Add the latest reply to the main chat draft."
        >
          {broughtBack ? 'Added to draft' : bringBackLabel}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open side chat as chat"
          onClick={() => onOpenAsChat(binding)}
        >
          <ArrowUpRight />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close side chat" onClick={onClose}>
          <X />
        </Button>
      </header>
      <p className="text-muted-foreground shrink-0 border-b px-3 py-1.5 text-[11px]">
        Includes the main chat as it was when this side chat opened.
        {binding.contextTruncated ? ' The copied context was shortened.' : ''}
      </p>
      {back.error && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {back.error}
        </p>
      )}
      {detail.error && (
        <p role="alert" className="text-destructive p-3 text-sm">
          {detail.error}
        </p>
      )}
      {fileError && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {fileError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden [&>section]:h-full">
        <WorkspaceConversation
          conversationId={binding.conversationId}
          workspacePath={runContext?.workspacePath}
          onOpenFile={openChatFile}
          scope={detail.data ? { projectId: detail.data.task.projectId, checkoutId: activeCheckoutId } : undefined}
        />
      </div>
      {snapshot.data?.runs.length === 0 && (
        <p className="text-muted-foreground shrink-0 px-4 pt-2 text-xs">
          Choose New worktree to run alongside the main chat in an isolated checkout.
        </p>
      )}
      {detail.data && (
        <WorkspaceComposer
          key={binding.conversationId}
          task={detail.data.task}
          conversationId={binding.conversationId}
          allowInitialCheckoutChoice
        />
      )}
    </section>
  )
}
