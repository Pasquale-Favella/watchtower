import { ChevronRight } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { WorkspaceFileIcon } from '../WorkspaceFileIcon.js'
import { useCheckoutDirectory } from './use-checkout-inspection.js'

interface Props {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly path: string
  readonly folder: boolean
  readonly onNavigateFolder: (path: string) => void
  readonly onOpenFile: (path: string) => void
}

function BreadcrumbChildren({ directory, ...props }: Props & { readonly directory: string }): React.JSX.Element {
  const listing = useCheckoutDirectory(props.scope, directory, props.revision)
  return (
    <>
      {listing.error && <DropdownMenuItem disabled>{listing.error.message}</DropdownMenuItem>}
      {!listing.data && !listing.error && <DropdownMenuItem disabled>Loading folder…</DropdownMenuItem>}
      {listing.data?.entries.map(entry => (
        <DropdownMenuItem
          key={entry.path}
          onClick={() => {
            if (entry.kind === 'directory') props.onNavigateFolder(entry.path)
            else props.onOpenFile(entry.path)
          }}
        >
          <WorkspaceFileIcon path={entry.path + (entry.kind === 'directory' ? '/' : '')} />
          <span className="min-w-0 truncate">{entry.name}</span>
        </DropdownMenuItem>
      ))}
      {listing.data?.entries.length === 0 && <DropdownMenuItem disabled>Empty folder</DropdownMenuItem>}
    </>
  )
}

export function FileBreadcrumbs(props: Props): React.JSX.Element {
  const segments = props.path.split('/').filter(Boolean)
  return (
    <nav
      aria-label="File breadcrumbs"
      className="flex min-w-0 flex-1 items-center overflow-x-auto text-xs whitespace-nowrap"
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground shrink-0 px-1"
        onClick={() => props.onNavigateFolder('')}
      >
        Files
      </button>
      {['', ...segments].map((segment, index) => {
        const directory = segments.slice(0, index).join('/')
        const isFile = index === segments.length && !props.folder && index > 0
        return (
          <span key={directory} className="flex shrink-0 items-center">
            {index > 0 && (
              <button
                type="button"
                title={directory}
                className="max-w-40 truncate px-0.5 hover:underline"
                onClick={() => (isFile ? props.onOpenFile(directory) : props.onNavigateFolder(directory))}
              >
                {segment}
              </button>
            )}
            {!isFile && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" aria-label={`Browse ${directory || 'checkout'} folder`} />
                  }
                >
                  <ChevronRight className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 max-w-80 overflow-y-auto">
                  <BreadcrumbChildren {...props} directory={directory} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        )
      })}
    </nav>
  )
}
