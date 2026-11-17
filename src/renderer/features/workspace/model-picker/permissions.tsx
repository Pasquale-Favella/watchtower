import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ChevronUp } from 'lucide-react'
import { useId, useState } from 'react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { cn } from '@/renderer/shared/lib/utils'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'

import { accessModeConfig, type AccessModeOption } from './access-mode.js'
import { composerControlClass } from './composer-control.js'

interface PermissionsProps {
  readonly mode: AgentAccessMode
  readonly options: readonly AccessModeOption[]
  readonly onChange: (mode: AgentAccessMode) => void
}

/**
 * Permission modes as one horizontal toggle, with the shown mode named below. Each segment is a menu radio item, so
 * arrow keys reach it and a pick closes the menu. Hover or focus previews a mode before it is picked.
 */
export function PermissionsSection({ mode, options, onChange }: PermissionsProps) {
  const [previewMode, setPreviewMode] = useState<AgentAccessMode | null>(null)
  const shownMode = previewMode ?? mode
  const shown = accessModeConfig[shownMode]
  const descriptionId = useId()
  return (
    <div className="grid w-72 gap-1.5 px-2 py-1.5">
      <div className="text-muted-foreground text-xs font-medium">Permissions</div>
      <MenuPrimitive.RadioGroup
        aria-label="Permissions"
        value={mode}
        onValueChange={(value: AgentAccessMode) => {
          if (value !== mode) onChange(value)
        }}
        className="bg-input/40 flex rounded-lg p-0.5"
        // Menus move with Up/Down only; the row reads horizontally, so Left/Right move too.
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
          const index = items.findIndex(item => item === document.activeElement)
          const next = items[index + (event.key === 'ArrowRight' ? 1 : -1)]
          if (index < 0 || !next) return
          event.preventDefault()
          event.stopPropagation()
          next.focus()
        }}
      >
        {options.map(option => {
          const Icon = option.icon
          return (
            <MenuPrimitive.RadioItem
              key={option.mode}
              value={option.mode}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.mode}`}
              closeOnClick
              onPointerEnter={() => setPreviewMode(option.mode)}
              onPointerLeave={() => setPreviewMode(null)}
              onFocus={() => setPreviewMode(option.mode)}
              onBlur={() => setPreviewMode(null)}
              className="text-muted-foreground data-checked:bg-input data-checked:text-foreground data-highlighted:text-foreground not-data-checked:data-highlighted:bg-accent focus-visible:ring-ring flex h-6 flex-1 cursor-pointer items-center justify-center outline-none first:rounded-l-md last:rounded-r-md focus-visible:ring-2 focus-visible:ring-inset"
            >
              <Icon aria-hidden className="size-3.5" />
            </MenuPrimitive.RadioItem>
          )
        })}
      </MenuPrimitive.RadioGroup>
      {options.map(option => (
        <span key={option.mode} id={`${descriptionId}-${option.mode}`} className="sr-only">
          {option.description}
        </span>
      ))}
      <div className="grid gap-0.5" aria-hidden>
        <span className={cn('text-sm', shownMode === mode ? 'text-foreground' : 'text-muted-foreground')}>
          {shown.label}
        </span>
        {/* Two lines reserved so the menu does not shift while modes are previewed. */}
        <span className="text-muted-foreground min-h-8 text-xs leading-4">{shown.description}</span>
      </div>
    </div>
  )
}

/** Composer chip naming the permissions the next message uses. It opens the permissions toggle. */
export function PermissionsChip({
  className,
  size = 'sm',
  ...props
}: PermissionsProps & { readonly className?: string; readonly size?: 'sm' | 'xs' }) {
  const { icon: Icon, label, description } = accessModeConfig[props.mode]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Permissions: ${label}`}
        title={`Permissions: ${label}. ${description}`}
        className={composerControlClass(cn(size === 'xs' && 'text-muted-foreground h-6 px-1.5 text-[11px]', className))}
      >
        <Icon aria-hidden className={size === 'xs' ? 'size-3' : 'size-3.5'} />
        <span>{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={6} className="w-auto">
        <PermissionsSection {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The model picker's footer. Permissions change rarely, so they sit one menu deeper. */
export function PermissionsFooter(props: PermissionsProps) {
  const { icon: Icon, label } = accessModeConfig[props.mode]
  return (
    <div className="border-border/70 bg-muted/40 flex items-center gap-2 border-t px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Permissions: ${label}`}
          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring data-popup-open:bg-foreground/10 data-popup-open:text-foreground ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
          <ChevronUp aria-hidden className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={6} className="w-auto">
          <PermissionsSection {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
