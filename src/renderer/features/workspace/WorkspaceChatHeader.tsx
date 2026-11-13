import { Folder, Info, PanelRight, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { SidebarTrigger } from '@/renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

import { submitModifier } from './platform-labels.js'

interface Props {
  readonly project: ReactNode
  readonly title: string
  readonly terminalOpen?: boolean
  readonly onToggleTerminal?: (() => void) | undefined
  readonly panelOpen?: boolean
  readonly onTogglePanel?: (() => void) | undefined
  readonly detailsOpen: boolean
  readonly onToggleDetails: () => void
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
        <HeaderToggle label="Agent run details" pressed={props.detailsOpen} onClick={props.onToggleDetails}>
          <Info />
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
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly pressed: boolean
  readonly onClick: (() => void) | undefined
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          disabled={!onClick}
          onClick={onClick}
          className={pressed ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint && <span className="text-muted-foreground ml-2">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
