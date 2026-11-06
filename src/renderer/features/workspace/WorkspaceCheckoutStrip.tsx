import { Command as CommandPrimitive } from 'cmdk'
import { Check, ChevronDown, FolderGit2, GitBranch, GitBranchPlus, LoaderCircle, SearchIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Command, CommandEmpty, CommandItem, CommandList } from '@/renderer/components/ui/command.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { CheckoutBranches } from '@/shared/schemas/checkout.js'

import { branchTriggerLabel, type CheckoutMode } from './checkout-strip-state.js'
import { composerControlClass } from './model-picker/composer-control.js'

const STRIP_CONTROL = 'text-muted-foreground h-6 gap-1 px-1.5 text-[11px] font-normal [&_svg]:size-3.5'
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

function ModeControl({
  mode,
  lockedKind,
  disabled,
  onChange,
}: {
  readonly mode: CheckoutMode
  /** Set once the chat has a checkout. The control then only names it. */
  readonly lockedKind?: 'main' | 'worktree' | 'directory' | undefined
  readonly disabled?: boolean | undefined
  readonly onChange?: ((mode: CheckoutMode) => void) | undefined
}) {
  if (lockedKind || !onChange) {
    const worktree = lockedKind ? lockedKind === 'worktree' : mode === 'worktree'
    const Icon = worktree ? GitBranchPlus : FolderGit2
    return (
      <span className={cn(composerControlClass(STRIP_CONTROL), 'pointer-events-none')} aria-label="Checkout">
        <Icon aria-hidden />
        {worktree ? 'Worktree' : 'Local checkout'}
      </span>
    )
  }
  const Icon = mode === 'worktree' ? GitBranchPlus : FolderGit2
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Checkout: ${MODE_LABELS[mode]}`}
        title={MODE_DESCRIPTIONS[mode]}
        disabled={disabled}
        className={composerControlClass(STRIP_CONTROL)}
      >
        <Icon aria-hidden />
        {MODE_LABELS[mode]}
        <ChevronDown aria-hidden className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="w-64">
        <DropdownMenuRadioGroup value={mode} onValueChange={value => onChange(value as CheckoutMode)}>
          {(['local', 'worktree'] as const).map(option => {
            const OptionIcon = option === 'worktree' ? GitBranchPlus : FolderGit2
            return (
              <DropdownMenuRadioItem key={option} value={option} className="items-start py-1.5">
                <OptionIcon className="text-muted-foreground mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12px]">{MODE_LABELS[option]}</span>
                  <span className="text-muted-foreground text-[11px] leading-4">{MODE_DESCRIPTIONS[option]}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BranchControl({
  label,
  value,
  branches,
  pending,
  disabled,
  allowCheckedOutElsewhere,
  onSelect,
}: {
  readonly label: string
  readonly value: string | null
  readonly branches: CheckoutBranches | null
  readonly pending: boolean
  readonly disabled: boolean
  /** A new worktree can start from a branch another worktree has checked out; switching to it cannot. */
  readonly allowCheckedOutElsewhere: boolean
  readonly onSelect: (branch: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        setQuery('')
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-label="Branch"
            aria-expanded={open}
            disabled={disabled || !branches}
            title={label}
            className={composerControlClass(cn(STRIP_CONTROL, 'max-w-56 min-w-0'))}
          >
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <GitBranch aria-hidden />}
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown aria-hidden className="opacity-60" />
          </button>
        }
      />
      <PopoverContent side="bottom" align="start" className="w-72 gap-0 overflow-hidden p-0">
        <Command className="bg-transparent p-0">
          <div className="px-3 pt-2.5">
            <div className="focus-within:border-ring border-border/70 relative border-b pb-1.5 transition-colors">
              <SearchIcon
                aria-hidden
                className="text-muted-foreground/55 pointer-events-none absolute top-1.5 left-0 size-4"
              />
              <CommandPrimitive.Input
                aria-label="Search branches"
                placeholder="Search branches…"
                value={query}
                onValueChange={setQuery}
                className="placeholder:text-muted-foreground h-6.5 w-full bg-transparent ps-5 text-sm leading-6.5 outline-hidden"
              />
            </div>
          </div>
          <CommandList className="max-h-72 p-1">
            <CommandEmpty className="py-2">No matching branches.</CommandEmpty>
            {branches?.branches.map(branch => {
              const elsewhere = branch.worktreePath !== null && !allowCheckedOutElsewhere
              return (
                <CommandItem
                  key={branch.name}
                  value={branch.name}
                  disabled={elsewhere}
                  data-current={branch.name === value}
                  title={elsewhere ? `Checked out in ${branch.worktreePath}` : branch.name}
                  className="data-[current=true]:bg-muted/60 min-h-7 cursor-pointer text-[12px]"
                  onSelect={() => {
                    setOpen(false)
                    if (branch.name !== value) onSelect(branch.name)
                  }}
                >
                  <GitBranch className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.isDefault && <span className="text-muted-foreground text-[10.5px]">default</span>}
                  {elsewhere && <span className="text-muted-foreground text-[10.5px]">worktree</span>}
                  {branch.name === value && <Check aria-hidden className="size-3.5" />}
                </CommandItem>
              )
            })}
            {branches?.truncated && (
              <p className="text-muted-foreground px-2 py-1.5 text-[11px]">Showing the most recent branches.</p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The row under the composer: where the chat runs, on which branch, and anything
 * the caller adds at the end (such as permissions). A new chat chooses the checkout; a started chat names it.
 */
export function CheckoutStrip({
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
}: {
  readonly mode: CheckoutMode
  readonly lockedKind?: 'main' | 'worktree' | 'directory' | undefined
  readonly onModeChange?: ((mode: CheckoutMode) => void) | undefined
  /** The branch shown: the checked-out branch, or the base of a new worktree. */
  readonly branch: string | null
  readonly branches: CheckoutBranches | null
  readonly pending: boolean
  readonly disabled: boolean
  readonly onBranchSelect: (branch: string) => void
  readonly error?: string | null | undefined
  readonly trailing?: ReactNode
}) {
  const locked = lockedKind !== undefined
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex w-full min-w-0 items-center gap-1">
        <ModeControl mode={mode} lockedKind={lockedKind} disabled={disabled} onChange={onModeChange} />
        {lockedKind !== 'directory' && (
          <BranchControl
            label={branchControlLabel(branches, error, mode, locked, branch)}
            value={branch}
            branches={branches}
            pending={pending}
            disabled={disabled}
            allowCheckedOutElsewhere={mode === 'worktree' && !locked}
            onSelect={onBranchSelect}
          />
        )}
        {trailing && <div className="ms-auto flex shrink-0 items-center">{trailing}</div>}
      </div>
      {error && (
        <p className="text-destructive px-1.5 text-[11px]" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
