import { SlidersHorizontal, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { PopoverContent } from '@/renderer/components/ui/popover'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { currentConversationRuns, isRunActive } from './composer-state.js'
import { useWorkspaceTaskSnapshot } from './hooks.js'
import { CONVERSATION_DETAILS_ITEMS, useConversationDetailsItems } from './use-conversation-details-items.js'
import type { ConversationDetailsMode } from './use-conversation-details-layout.js'
import { WorkspaceConversationDetailsActions } from './WorkspaceConversationDetailsActions.js'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly mode: ConversationDetailsMode
  readonly taskId?: TaskId | undefined
  readonly conversationId?: ConversationId | null
  readonly projectId?: ProjectId | undefined
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly workspacePath?: string | undefined
  readonly isScratch?: boolean | undefined
  readonly onOpenDiff?: (() => void) | undefined
  readonly onOpenFiles?: (() => void) | undefined
  readonly onOpenPullRequests?: (() => void) | undefined
  readonly onOpenSideChat?: ((id: string) => void) | undefined
  readonly checkoutControls?: ReactNode
  readonly children?: ReactNode
}

export function WorkspaceConversationDetails({
  open,
  onOpenChange,
  mode,
  taskId,
  conversationId,
  projectId,
  checkoutId,
  workspacePath,
  isScratch,
  onOpenDiff,
  onOpenFiles,
  onOpenPullRequests,
  onOpenSideChat,
  checkoutControls,
  children,
}: Props): React.JSX.Element | null {
  const items = useConversationDetailsItems()
  const snapshot = useWorkspaceTaskSnapshot(taskId ? { taskId, runLimit: 100 } : null)
  const runs = conversationId
    ? currentConversationRuns(snapshot.data?.runs ?? [], snapshot.data?.runContexts ?? [], conversationId)
    : []

  const menuItems = (
    <>
      {CONVERSATION_DETAILS_ITEMS.map(item => (
        <DropdownMenuCheckboxItem
          key={item.id}
          checked={items.visible[item.id]}
          onCheckedChange={checked => items.setVisible(item.id, checked)}
          closeOnClick={false}
        >
          {item.label}
        </DropdownMenuCheckboxItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={items.reset}>Reset to defaults</DropdownMenuItem>
    </>
  )

  const card = (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div className="flex min-h-0 flex-col" />}
        onContextMenuCapture={event => {
          const target = event.target
          const selection = window.getSelection()
          if (
            (target instanceof Element && target.closest('input, textarea, [contenteditable], a[href]')) ||
            (selection && !selection.isCollapsed)
          )
            event.stopPropagation()
        }}
      >
        <div className="flex h-9 shrink-0 items-center justify-between px-2">
          <h2 id="conversation-details-title" className="sr-only">
            Conversation details
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Customize conversation details" />
              }
            >
              <SlidersHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {menuItems}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close conversation details"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-2 pb-2 text-sm">
          <WorkspaceConversationDetailsActions
            visible={items.visible}
            projectId={projectId}
            checkoutId={checkoutId}
            workspacePath={workspacePath}
            taskId={taskId}
            conversationId={conversationId}
            activeRun={Boolean(taskId && (!snapshot.data || snapshot.error || runs.some(isRunActive)))}
            isScratch={isScratch}
            onOpenDiff={onOpenDiff}
            onOpenFiles={onOpenFiles}
            onOpenPullRequests={onOpenPullRequests}
            onOpenSideChat={onOpenSideChat}
            checkoutControls={checkoutControls}
          />
          {snapshot.error && (
            <p role="alert" className="text-destructive px-2.5 text-xs">
              {snapshot.error}
            </p>
          )}
          {children && <DetailsSection label="Conversations">{children}</DetailsSection>}
          {!taskId && !projectId && (
            <p className="text-muted-foreground text-xs">Select a project to see workspace actions.</p>
          )}
        </div>
      </ContextMenuTrigger>
      <DropdownMenuContent className="w-48">{menuItems}</DropdownMenuContent>
    </ContextMenu>
  )

  return (
    <>
      <PopoverContent
        role="dialog"
        aria-label="Conversation details"
        aria-labelledby="conversation-details-title"
        id={open && mode === 'popover' ? 'conversation-details-panel' : undefined}
        data-conversation-details-panel={open && mode === 'popover' ? 'popover' : undefined}
        className={`bg-card flex max-h-[min(80vh,40rem)] w-[280px] gap-0 overflow-hidden rounded-xl border p-0 shadow-lg ${mode === 'inline' ? 'hidden' : ''}`}
        align="end"
        side="bottom"
        sideOffset={8}
      >
        {open && mode === 'popover' ? card : null}
      </PopoverContent>
      {open && mode === 'inline' && (
        <aside
          aria-label="Conversation details"
          data-conversation-details-panel="inline"
          id="conversation-details-panel"
          className="bg-card absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[280px] flex-col overflow-hidden rounded-xl border shadow-sm"
        >
          {card}
        </aside>
      )}
    </>
  )
}

function DetailsSection({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-muted-foreground text-xs font-medium">{label}</h3>
      {children}
    </section>
  )
}
