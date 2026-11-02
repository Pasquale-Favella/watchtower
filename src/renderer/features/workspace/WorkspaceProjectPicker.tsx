import { Check, ChevronDown, Folder, FolderPlus, MessageSquare } from 'lucide-react'
import { useState } from 'react'

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/renderer/components/ui/command.js'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceProjectDialog } from './use-project-dialog.js'

interface Props {
  readonly projectId: ProjectId | null
  readonly label: string
  readonly projects: WorkspaceProjectReadPage['items']
  readonly hasMore: boolean
  readonly disabled: boolean
  readonly onSelect: (projectId: ProjectId | null) => void
  readonly onLoadMore: () => void
  readonly onRefresh: () => void
}

export function WorkspaceProjectPicker({
  projectId,
  label,
  projects,
  hasMore,
  disabled,
  onSelect,
  onLoadMore,
  onRefresh,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const registration = useWorkspaceProjectDialog()
  function select(id: ProjectId | null) {
    onSelect(id)
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        setQuery('')
        if (next) onRefresh()
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-label="Project"
            aria-expanded={open}
            disabled={disabled}
            className="hover:text-foreground text-foreground/80 focus-visible:ring-ring inline-flex max-w-full min-w-0 cursor-pointer items-baseline gap-1 rounded-sm border-b border-dotted border-current/40 font-medium outline-none focus-visible:ring-2 disabled:opacity-50"
          >
            <span className="max-w-[min(50vw,24rem)] truncate">{label}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 self-center opacity-60" />
          </button>
        }
      />
      <PopoverContent align="center" className="w-72 p-0">
        <Command>
          <CommandInput
            aria-label="Search Projects"
            placeholder="Search projects…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matching projects.</CommandEmpty>
            <CommandItem value="No project" onSelect={() => select(null)}>
              <MessageSquare className="text-muted-foreground size-4" />
              No project
              {projectId === null && <Check className="ml-auto size-4" />}
            </CommandItem>
            {projects.map(project => (
              <CommandItem key={project.id} value={`${project.name} ${project.id}`} onSelect={() => select(project.id)}>
                <Folder className="text-muted-foreground size-4" />
                <span className="truncate">{project.name}</span>
                {projectId === project.id && <Check className="ml-auto size-4" />}
              </CommandItem>
            ))}
            {hasMore && (
              <CommandItem value="Load more projects" onSelect={onLoadMore}>
                Load more projects…
              </CommandItem>
            )}
            {!query.trim() && (
              <>
                <CommandSeparator />
                <CommandItem
                  value="Add project"
                  onSelect={() => {
                    setOpen(false)
                    registration.open()
                  }}
                >
                  <FolderPlus className="text-muted-foreground size-4" />
                  Add project
                </CommandItem>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
