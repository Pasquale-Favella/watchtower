import { ChevronRight, Folder, PanelRight, SquareMenu, SquareTerminal } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { PopoverTrigger } from '@/renderer/components/ui/popover'
import { SidebarTrigger } from '@/renderer/components/ui/sidebar'
import { TextTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

import type { ParentTaskLink } from './delegation/chat-delegation-hooks.js'
import { submitModifier } from './platform-labels.js'
import type { ConversationDetailsMode } from './use-conversation-details-layout.js'

interface Props {
  readonly project: ReactNode
  readonly title: string
  readonly parentTask?: ParentTaskLink | null
  readonly terminalOpen?: boolean
  readonly onToggleTerminal?: (() => void) | undefined
  readonly panelOpen?: boolean
  readonly onTogglePanel?: (() => void) | undefined
  readonly detailsOpen: boolean
  readonly detailsMode: ConversationDetailsMode
  readonly onToggleDetails: (() => void) | undefined
  readonly relatedDelegationCount?: number | undefined
}

export function WorkspaceChatHeader(props: Props): React.JSX.Element {
  const relatedCount = props.relatedDelegationCount ?? 0
  const relatedLabel = `${relatedCount} delegated task${relatedCount === 1 ? '' : 's'}`
  return (
    <header aria-label="Chat header" className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger aria-label="Toggle workspace navigation" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <Folder aria-hidden="true" className="text-muted-foreground hidden size-3.5 shrink-0 sm:block" />
        <div className="text-muted-foreground max-w-[40%] min-w-0 truncate">{props.project}</div>
        <span aria-hidden="true" className="text-muted-foreground/50">
          /
        </span>
        {props.parentTask && <ParentTaskBreadcrumb parent={props.parentTask} />}
        <TextTooltip label={props.title} trigger={<h1 className="min-w-0 truncate font-medium">{props.title}</h1>} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderToggle
          label="Conversation details"
          tooltipSide="left"
          pressed={props.detailsOpen}
          onClick={props.onToggleDetails}
          popoverTrigger={props.detailsMode === 'popover'}
          controls="conversation-details-panel"
          count={relatedCount}
          countLabel={relatedCount > 0 ? relatedLabel : undefined}
        >
          <SquareMenu />
        </HeaderToggle>
        <HeaderToggle
          label="Terminal"
          hint={props.onToggleTerminal ? `${submitModifier}+J` : 'Available after the first message'}
          pressed={props.terminalOpen ?? false}
          onClick={props.onToggleTerminal}
        >
          <SquareTerminal />
        </HeaderToggle>
        <HeaderToggle
          label="Right panel"
          hint={props.onTogglePanel ? `${submitModifier}+Alt+B` : 'Right panel is unavailable'}
          pressed={props.panelOpen ?? false}
          onClick={props.onTogglePanel}
        >
          <PanelRight />
        </HeaderToggle>
      </div>
    </header>
  )
}

function ParentTaskBreadcrumb({ parent }: { readonly parent: ParentTaskLink }): React.JSX.Element {
  const label = `Open parent task: ${parent.title}`
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring max-w-[30%] min-w-0 truncate rounded-sm focus-visible:ring-2"
              aria-label={label}
              onClick={parent.open}
            />
          }
        >
          {parent.title}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <ChevronRight aria-hidden className="text-muted-foreground/50 size-3 shrink-0" />
    </>
  )
}

function HeaderToggle({
  label,
  hint,
  pressed,
  onClick,
  popoverTrigger = false,
  tooltipSide,
  controls,
  count,
  countLabel,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly pressed: boolean
  readonly onClick: (() => void) | undefined
  readonly popoverTrigger?: boolean
  readonly tooltipSide?: ComponentProps<typeof TooltipContent>['side']
  readonly controls?: string
  readonly count?: number | undefined
  readonly countLabel?: string | undefined
  readonly children: ReactNode
}): React.JSX.Element {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={controls ? pressed : undefined}
      aria-controls={controls}
      disabled={!onClick}
      onClick={popoverTrigger ? undefined : onClick}
      className={`${pressed ? 'bg-primary/10 text-primary' : 'text-muted-foreground'} relative`}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-[9px] leading-4">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {popoverTrigger ? <PopoverTrigger render={button} /> : button}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        {label}
        {(countLabel || hint) && <span className="text-muted-foreground ml-2">{countLabel ?? hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
