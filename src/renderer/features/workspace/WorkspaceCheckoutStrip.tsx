import { ChevronDown, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, LoaderCircle } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { buttonVariants } from '@/renderer/components/ui/button.js'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/renderer/components/ui/command.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover.js'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { CheckoutBranches } from '@/shared/schemas/checkout.js'

import { branchTriggerLabel, type CheckoutMode } from './checkout-strip-state.js'
import { composerControlClass } from './model-picker/composer-control.js'

const STRIP_CONTROL = 'text-muted-foreground h-6 gap-1 px-1.5 text-[11px] font-normal [&_svg]:size-3.5'
const DETAILS_ROW_CLASS =
  'h-8 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-foreground/80'
const MODE_LABELS: Readonly<Record<CheckoutMode, string>> = {
  local: 'Current checkout',
  worktree: 'New worktree',
}
const MODE_DESCRIPTIONS: Readonly<Record<CheckoutMode, string>> = {
  local: 'Work in the Project folder on its checked-out branch.',
  worktree: 'Create an isolated worktree on a new branch when you send.',
}

function branchControlLabel(
  branches: CheckoutBranches | null,
  error: string | null | undefined,
  mode: CheckoutMode,
  locked: boolean,
  branch: string | null,
): string {
  if (branches) return branchTriggerLabel(mode, locked, branch)
  return error ? 'Branches unavailable' : 'Reading branches…'
}

function lockedCheckoutLabel(
  layout: 'composer' | 'details',
  mode: CheckoutMode,
  lockedKind: 'main' | 'worktree' | 'directory' | undefined,
  workspacePath: string | null | undefined,
): string {
  if (lockedKind === 'directory') return 'Directory'
  if (lockedKind === 'worktree') {
    if (layout === 'composer') return 'Worktree'
    return workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Worktree'
  }
  if (lockedKind === 'main' && layout === 'details') return 'Local checkout'
  if (layout === 'composer') return mode === 'worktree' ? 'Worktree' : 'Local checkout'
  return MODE_LABELS[mode]
}

function CheckoutControl({
  layout,
  mode,
  lockedKind,
  workspacePath,
  disabled,
  onChange,
}: {
  readonly layout: 'composer' | 'details'
  readonly mode: CheckoutMode
  readonly lockedKind?: 'main' | 'worktree' | 'directory' | undefined
  readonly workspacePath?: string | null | undefined
  readonly disabled: boolean
  readonly onChange?: ((mode: CheckoutMode) => void) | undefined
}): React.JSX.Element {
  if (lockedKind || !onChange) {
    const label = lockedCheckoutLabel(layout, mode, lockedKind, workspacePath)

    let Icon = FolderGit2
    if (lockedKind === 'worktree' || (!lockedKind && mode === 'worktree')) Icon = GitBranchPlus
    else if (lockedKind === 'directory') Icon = FolderOpen

    return (
      <TextTooltip
        label={workspacePath ? `${label} · ${workspacePath}` : label}
        side={layout === 'details' ? 'left' : 'top'}
        trigger={
          <span
            className={
              layout === 'details'
                ? 'text-foreground/80 flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium'
                : composerControlClass(STRIP_CONTROL)
            }
            aria-label={`Checkout: ${label}`}
          >
            <Icon aria-hidden className={layout === 'details' ? 'text-muted-foreground size-4 shrink-0' : undefined} />
            <span className={layout === 'details' ? 'min-w-0 flex-1 truncate' : undefined}>{label}</span>
          </span>
        }
      />
    )
  }

  const Icon = mode === 'worktree' ? GitBranchPlus : FolderGit2
  return (
    <DropdownMenu>
      <TextTooltip
        label={layout === 'details' ? undefined : MODE_DESCRIPTIONS[mode]}
        trigger={
          <DropdownMenuTrigger
            aria-label={layout === 'details' ? 'Checkout' : `Checkout: ${MODE_LABELS[mode]}`}
            disabled={disabled}
            className={
              layout === 'details'
                ? buttonVariants({ variant: 'ghost', className: DETAILS_ROW_CLASS })
                : composerControlClass(STRIP_CONTROL)
            }
          >
            <Icon aria-hidden className={layout === 'details' ? 'text-muted-foreground size-4 shrink-0' : undefined} />
            <span className={layout === 'details' ? 'min-w-0 flex-1 truncate' : undefined}>{MODE_LABELS[mode]}</span>
            <ChevronDown
              aria-hidden
              className={layout === 'details' ? 'text-muted-foreground ms-auto size-4 shrink-0' : 'opacity-60'}
            />
          </DropdownMenuTrigger>
        }
      />
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={layout === 'details' ? 4 : 6}
        className={layout === 'details' ? 'w-(--anchor-width) min-w-56' : 'w-64'}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode} onValueChange={value => onChange(value as CheckoutMode)}>
            {(['local', 'worktree'] as const).map(option => {
              const OptionIcon = option === 'worktree' ? GitBranchPlus : FolderGit2
              return (
                <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                  <OptionIcon aria-hidden className="text-muted-foreground" />
                  {MODE_LABELS[option]}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BranchControl({
  layout,
  label,
  value,
  branches,
  pending,
  disabled,
  allowCheckedOutElsewhere,
  error,
  onSelect,
}: {
  readonly layout: 'composer' | 'details'
  readonly label: string
  readonly value: string | null
  readonly branches: CheckoutBranches | null
  readonly pending: boolean
  readonly disabled: boolean
  readonly allowCheckedOutElsewhere: boolean
  readonly error?: string | null | undefined
  readonly onSelect: (branch: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const sorted = [...(branches?.branches ?? [])].sort((left, right) => left.name.localeCompare(right.name))
  const groups = [
    { label: 'Current', branches: sorted.filter(branch => branch.current) },
    {
      label: 'Default',
      branches: sorted.filter(branch => !branch.current && branch.isDefault && !branch.worktreePath),
    },
    {
      label: 'Branches',
      branches: sorted.filter(branch => !branch.current && !branch.isDefault && !branch.worktreePath),
    },
    { label: 'In another worktree', branches: sorted.filter(branch => !branch.current && branch.worktreePath) },
  ].filter(group => group.branches.length > 0)

  const triggerContent = (
    <>
      {pending ? (
        <LoaderCircle
          aria-hidden
          className={layout === 'details' ? 'text-muted-foreground size-4 shrink-0 animate-spin' : 'animate-spin'}
        />
      ) : (
        <GitBranch aria-hidden className={layout === 'details' ? 'text-muted-foreground size-4 shrink-0' : undefined} />
      )}
      <span className={layout === 'details' ? 'min-w-0 flex-1 truncate text-left' : 'min-w-0 truncate'}>{label}</span>
      <ChevronDown
        aria-hidden
        className={layout === 'details' ? 'text-muted-foreground ms-auto size-4 shrink-0' : 'opacity-60'}
      />
    </>
  )
  const trigger = (
    <button
      type="button"
      role="combobox"
      aria-label="Branch"
      aria-expanded={open}
      aria-haspopup="listbox"
      disabled={disabled || !branches}
      className={
        layout === 'details'
          ? buttonVariants({ variant: 'ghost', className: DETAILS_ROW_CLASS })
          : composerControlClass(cn(STRIP_CONTROL, 'max-w-56 min-w-0'))
      }
    >
      {triggerContent}
    </button>
  )

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <TextTooltip
        label={label}
        side={layout === 'details' ? 'left' : 'top'}
        trigger={<PopoverTrigger render={trigger} />}
      />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={layout === 'details' ? 4 : undefined}
        className={
          layout === 'details'
            ? 'w-(--anchor-width) min-w-56 gap-0 overflow-hidden p-0'
            : 'w-72 gap-0 overflow-hidden p-0'
        }
      >
        <Command className={layout === 'composer' ? 'bg-transparent p-0' : undefined}>
          <CommandInput
            aria-label="Search branches"
            placeholder="Search branches…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className={cn('max-h-72', layout === 'composer' && 'p-1')}>
            <CommandEmpty>{error ? 'Branches unavailable.' : 'No matching branches.'}</CommandEmpty>
            {groups.map(group => (
              <CommandGroup key={group.label} heading={group.label}>
                {group.branches.map(branch => {
                  const elsewhere = !branch.current && branch.worktreePath !== null && !allowCheckedOutElsewhere
                  const isSelected = branch.name === value
                  const selectedLabel =
                    allowCheckedOutElsewhere && !branch.current ? 'selected base branch' : 'current branch'
                  return (
                    <TextTooltip
                      key={branch.name}
                      label={branch.worktreePath ? `Checked out in ${branch.worktreePath}` : branch.name}
                      side={layout === 'details' ? 'left' : 'top'}
                      trigger={
                        <CommandItem
                          value={`${branch.name} ${branch.isDefault ? 'default' : ''} ${elsewhere ? 'worktree' : ''}`}
                          disabled={elsewhere || disabled}
                          data-checked={isSelected}
                          aria-label={`${branch.name}${isSelected ? `, ${selectedLabel}` : ''}${branch.isDefault ? ', default branch' : ''}${branch.worktreePath ? `, checked out in ${branch.worktreePath}` : ''}`}
                          className={layout === 'composer' ? 'min-h-7 cursor-pointer text-[12px]' : undefined}
                          onSelect={() => {
                            setOpen(false)
                            setQuery('')
                            if (!isSelected) onSelect(branch.name)
                          }}
                        >
                          {layout === 'composer' && <GitBranch className="text-muted-foreground" />}
                          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                          {branch.isDefault && <span className="text-muted-foreground text-[11px]">default</span>}
                          {branch.worktreePath && <span className="text-muted-foreground text-[11px]">worktree</span>}
                          {isSelected && <span className="sr-only">{selectedLabel}</span>}
                        </CommandItem>
                      }
                    />
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
          {branches?.truncated && (
            <p className="text-muted-foreground border-t px-3 py-2 text-xs">Showing the most recent branches.</p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The composer chooses its checkout; a started Conversation shows the checkout it uses. */
export function CheckoutStrip({
  layout = 'composer',
  mode,
  lockedKind,
  onModeChange,
  branch,
  branches,
  pending,
  disabled,
  onBranchSelect,
  error,
  trailing,
  workspacePath,
}: {
  readonly layout?: 'composer' | 'details'
  readonly mode: CheckoutMode
  readonly lockedKind?: 'main' | 'worktree' | 'directory' | undefined
  readonly onModeChange?: ((mode: CheckoutMode) => void) | undefined
  readonly branch: string | null
  readonly branches: CheckoutBranches | null
  readonly pending: boolean
  readonly disabled: boolean
  readonly onBranchSelect: (branch: string) => void
  readonly error?: string | null | undefined
  readonly trailing?: ReactNode
  readonly workspacePath?: string | null | undefined
}): React.JSX.Element {
  const locked = lockedKind !== undefined
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div
        className={cn('flex w-full min-w-0 gap-1', layout === 'details' ? 'flex-col items-stretch' : 'items-center')}
      >
        <CheckoutControl
          layout={layout}
          mode={mode}
          lockedKind={lockedKind}
          workspacePath={workspacePath}
          disabled={disabled}
          onChange={onModeChange}
        />
        {lockedKind !== 'directory' && (
          <BranchControl
            layout={layout}
            label={branchControlLabel(branches, error, mode, locked, branch)}
            value={branch}
            branches={branches}
            pending={pending}
            disabled={disabled}
            allowCheckedOutElsewhere={mode === 'worktree' && !locked}
            error={error}
            onSelect={onBranchSelect}
          />
        )}
        {trailing && (
          <div className={cn('flex items-center', layout === 'details' ? 'min-w-0' : 'ms-auto shrink-0')}>
            {trailing}
          </div>
        )}
      </div>
      {error && (
        <p
          className={cn('text-destructive', layout === 'details' ? 'px-2.5 text-xs' : 'px-1.5 text-[11px]')}
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  )
}
