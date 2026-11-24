import { SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useRef } from 'react'

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
import { ScrollArea } from '@/renderer/components/ui/scroll-area'
import { cn } from '@/renderer/shared/lib/utils'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { currentConversationRuns, isRunActive } from './composer-state.js'
import { useWorkspaceTaskSnapshot } from './hooks.js'
import { CONVERSATION_DETAILS_ITEMS, useConversationDetailsItems } from './use-conversation-details-items.js'
import type { ConversationDetailsMode } from './use-conversation-details-layout.js'
import { WorkspaceConversationDetailsActions } from './WorkspaceConversationDetailsActions.js'

interface Props {
  readonly open: boolean
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
  // The popover opens where the inline card sits, at the conversation's top-right, rather than under the header toggle.
  const popoverAnchor = useRef<HTMLDivElement>(null)
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
  const nothingShown = CONVERSATION_DETAILS_ITEMS.every(item => !items.visible[item.id])

  // Customizing lives in the card's context menu; a visible control appears only once every item is hidden.
  const card = (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            data-conversation-details-card
            className={cn(
              'bg-popover/90 text-popover-foreground ring-foreground/10 grid max-h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl shadow-md ring-1 backdrop-blur-xl',
              mode === 'popover' && 'max-h-[min(calc(100dvh-6.5rem),40rem)]',
            )}
          />
        }
        onContextMenuCapture={event => {
          const target = event.target
          const selection = window.getSelection()
          if (
            (target instanceof Element && target.closest('input, textarea, select, [contenteditable], a[href]')) ||
            (selection && !selection.isCollapsed)
          )
            event.stopPropagation()
        }}
      >
        <h2 id="conversation-details-title" className="sr-only">
          Conversation details
        </h2>
        <ScrollArea scrollFade className="min-h-0">
          <div className="divide-border/65 divide-y text-sm">
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
              <p role="alert" className="text-destructive px-4.5 py-2 text-xs">
                {snapshot.error}
              </p>
            )}
            {children && <DetailsSection label="Conversations">{children}</DetailsSection>}
            {!taskId && !projectId && (
              <p className="text-muted-foreground px-4.5 py-3 text-xs">Select a project to see workspace actions.</p>
            )}
            {nothingShown && (
              <div className="p-2">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-foreground/80 h-8 w-full justify-start gap-2.5 px-2.5 text-[13px]"
                      />
                    }
                  >
                    <SlidersHorizontal aria-hidden="true" className="text-muted-foreground size-4" />
                    Choose what to show
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    {menuItems}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </ScrollArea>
      </ContextMenuTrigger>
      <DropdownMenuContent className="w-48">{menuItems}</DropdownMenuContent>
    </ContextMenu>
  )

  return (
    <>
      <div ref={popoverAnchor} aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-0 h-0" />
      <PopoverContent
        role="dialog"
        aria-label="Conversation details"
        aria-labelledby="conversation-details-title"
        id={open && mode === 'popover' ? 'conversation-details-panel' : undefined}
        data-conversation-details-panel={open && mode === 'popover' ? 'popover' : undefined}
        className={cn('w-[280px] gap-0 bg-transparent p-0 shadow-none ring-0', mode === 'inline' && 'hidden')}
        anchor={popoverAnchor}
        align="end"
        side="bottom"
        sideOffset={12}
      >
        {open && mode === 'popover' ? card : null}
      </PopoverContent>
      {open && mode === 'inline' && (
        <aside
          aria-label="Conversation details"
          data-conversation-details-panel="inline"
          id="conversation-details-panel"
          className="absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[280px] flex-col"
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
    <section aria-label={label} className="space-y-2 p-2">
      <h3 className="text-muted-foreground px-2.5 text-xs font-medium">{label}</h3>
      {children}
    </section>
  )
}
