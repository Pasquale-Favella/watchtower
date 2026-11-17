import { ChevronRightIcon, FileMinusIcon, FilePenLineIcon, FilePlusIcon } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { cn } from '@/renderer/shared/lib/utils'

import { ToolOutputPanel } from './ToolOutputPanel.js'

export interface ToolFileChange {
  readonly path: string
  readonly kind: 'add' | 'delete' | 'update'
  readonly diff?: string
}

const changeKinds = {
  add: { label: 'Added', Icon: FilePlusIcon, className: 'text-success' },
  delete: { label: 'Deleted', Icon: FileMinusIcon, className: 'text-destructive' },
  update: { label: 'Modified', Icon: FilePenLineIcon, className: 'text-muted-foreground' },
} as const

/** File changes are rendered only when the agent supplied their paths, kinds and optional patches. */
export function FileChangesBlock({ changes }: { readonly changes: readonly ToolFileChange[] }): React.JSX.Element {
  return (
    <ul className="space-y-1.5" aria-label="Changed files">
      {changes.map((change, index) => {
        const { Icon, label, className } = changeKinds[change.kind]
        return (
          <li key={`${change.path}:${index}`}>
            <Collapsible className="overflow-hidden rounded-md border">
              <CollapsibleTrigger
                disabled={!change.diff}
                className="group/disclosure bg-muted/30 flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-xs disabled:cursor-default"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    'size-3 shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90',
                    !change.diff && 'invisible',
                  )}
                />
                <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
                <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
                  {change.path}
                </span>
                <span className={cn('shrink-0 text-[11px]', className)}>{label}</span>
              </CollapsibleTrigger>
              {change.diff && (
                <CollapsibleContent className="p-2">
                  <ToolOutputPanel text={change.diff} label="Patch" />
                </CollapsibleContent>
              )}
            </Collapsible>
          </li>
        )
      })}
    </ul>
  )
}
