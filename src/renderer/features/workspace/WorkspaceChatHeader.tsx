import { Folder, PanelRight, SquareMenu, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { PopoverTrigger } from '@/renderer/components/ui/popover'
import { SidebarTrigger } from '@/renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

import { submitModifier } from './platform-labels.js'
import type { ConversationDetailsMode } from './use-conversation-details-layout.js'

interface Props {
  readonly project: ReactNode
  readonly title: string
  readonly terminalOpen?: boolean
  readonly onToggleTerminal?: (() => void) | undefined
  readonly panelOpen?: boolean
  readonly onTogglePanel?: (() => void) | undefined
  readonly detailsOpen: boolean
  readonly detailsMode: ConversationDetailsMode
  readonly onToggleDetails: (() => void) | undefined
}

export function WorkspaceChatHeader(props: Props): React.JSX.Element {
  return (
    <header aria-label="Chat header" className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger aria-label="Toggle workspace navigation" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <Folder aria-hidden="true" className="text-muted-foreground hidden size-3.5 shrink-0 sm:block" />
        <div className="text-muted-foreground max-w-[40%] min-w-0 truncate">{props.project}</div>
        <span aria-hidden="true" className="text-muted-foreground/50">
          /
        </span>
        <h1 className="min-w-0 truncate font-medium" title={props.title}>
          {props.title}
        </h1>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderToggle
          label="Conversation details"
          pressed={props.detailsOpen}
          onClick={props.onToggleDetails}
          popoverTrigger={props.detailsMode === 'popover'}
          controls="conversation-details-panel"
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

function HeaderToggle({
  label,
  hint,
  pressed,
  onClick,
  popoverTrigger = false,
  controls,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly pressed: boolean
  readonly onClick: (() => void) | undefined
  readonly popoverTrigger?: boolean
  readonly controls?: string
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
      className={pressed ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}
    >
      {children}
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {popoverTrigger ? <PopoverTrigger render={button} /> : button}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint && <span className="text-muted-foreground ml-2">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
