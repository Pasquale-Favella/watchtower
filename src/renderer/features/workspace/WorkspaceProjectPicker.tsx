import { Command as CommandPrimitive } from 'cmdk'
import { Folder, FolderPlus, MessageSquare, SearchIcon } from 'lucide-react'
import { useState } from 'react'

import { Command, CommandEmpty, CommandItem, CommandList } from '@/renderer/components/ui/command.js'
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

const ITEM_CLASS = 'min-h-7 cursor-pointer data-[current=true]:bg-muted/60'

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
            title={label}
            className="text-foreground focus-visible:outline-ring inline-flex max-w-full min-w-0 cursor-pointer items-baseline font-medium decoration-from-font underline-offset-4 hover:underline focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50 data-popup-open:underline"
          >
            <span className="max-w-[min(50vw,24rem)] truncate">{label}</span>
          </button>
        }
      />
      <PopoverContent align="center" className="w-72 gap-0 overflow-hidden p-0">
        <Command className="bg-transparent p-0">
          <div className="px-3 pt-2.5">
            <div className="focus-within:border-ring border-border/70 relative border-b pb-1.5 transition-colors">
              <SearchIcon
                aria-hidden="true"
                className="text-muted-foreground/55 pointer-events-none absolute top-1.5 left-0 size-4"
              />
              <CommandPrimitive.Input
                aria-label="Search Projects"
                placeholder="Search projects…"
                value={query}
                onValueChange={setQuery}
                className="placeholder:text-muted-foreground h-6.5 w-full bg-transparent ps-5 text-sm leading-6.5 outline-hidden"
              />
            </div>
          </div>
          <CommandList className="p-1">
            <CommandEmpty className="py-2">No matching projects.</CommandEmpty>
            <CommandItem
              value="No project"
              data-current={projectId === null}
              className={ITEM_CLASS}
              onSelect={() => select(null)}
            >
              <MessageSquare className="text-muted-foreground" />
              No project
            </CommandItem>
            {projects.map(project => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.id}`}
                data-current={projectId === project.id}
                className={ITEM_CLASS}
                onSelect={() => select(project.id)}
              >
                <Folder className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={project.name}>
                  {project.name}
                </span>
              </CommandItem>
            ))}
            {hasMore && (
              <CommandItem value="Load more projects" className={ITEM_CLASS} onSelect={onLoadMore}>
                <span className="text-muted-foreground">Load more projects…</span>
              </CommandItem>
            )}
            {!query.trim() && (
              <CommandItem
                value="Add project"
                className={ITEM_CLASS}
                onSelect={() => {
                  setOpen(false)
                  registration.open()
                }}
              >
                <FolderPlus className="text-muted-foreground" />
                Add project
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
