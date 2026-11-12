import { FileTree, useFileTree, useFileTreeSelector } from '@pierre/trees/react'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope, DiffFile } from '@/shared/schemas/checkout-inspection.js'

import { useCheckoutNavigation } from '../checkout-navigation/use-checkout-navigation.js'
import { useCodeTheme } from '../review/use-code-theme.js'
import { diffTreePresentation } from './diff-review-tree.js'

interface Props {
  readonly scope: CheckoutScope
  readonly files: readonly DiffFile[]
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly onReferencePath?: ((path: string) => void) | undefined
}

const TREE_CSS = `:host {
  --trees-bg-override: transparent;
  --trees-fg-override: var(--foreground);
  --trees-selected-bg-override: var(--muted);
  --trees-hover-bg-override: var(--muted);
  --trees-font-family-override: var(--font-sans);
  --trees-font-size-override: 11.5px;
} [data-truncate-content='visible'] { overflow:hidden; text-overflow:ellipsis; }
  [data-truncate-marker] { display:none; }
  button[data-type='item'],button[data-type='item']::before { border-radius:var(--radius-sm); }`

export function DiffFileTree(props: Props): React.JSX.Element {
  const theme = useCodeTheme()
  const [actionError, setActionError] = useState<string | null>(null)
  const presentation = useMemo(() => diffTreePresentation(props.files.map(file => file.path)), [props.files])
  const callbacks = useRef(props)
  const syncing = useRef(false)
  useEffect(() => {
    callbacks.current = props
  }, [props])
  const presentationRef = useRef(presentation)
  useEffect(() => {
    presentationRef.current = presentation
  }, [presentation])
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    density: 'compact',
    icons: { set: 'complete', colored: true },
    search: false,
    unsafeCSS: TREE_CSS,
    onSelectionChange: paths => {
      if (syncing.current) return
      const path = paths.at(-1)
      if (path && !path.endsWith('/')) callbacks.current.onSelectFile(presentationRef.current.selectionPath(path))
    },
    composition: { contextMenu: { enabled: true } },
  })
  useEffect(() => {
    const collapsed = presentation.directories.filter(path => {
      const item = model.getItem(path)
      return item !== null && 'isExpanded' in item && !item.isExpanded()
    })
    syncing.current = true
    model.resetPaths(presentation.paths)
    for (const path of collapsed) {
      const item = model.getItem(path)
      if (item !== null && 'collapse' in item) item.collapse()
    }
    model.setGitStatus(props.files.map(file => ({ path: presentation.modelPath(file.path), status: file.status })))
    syncing.current = false
  }, [model, presentation, props.files])
  useEffect(() => {
    if (!props.selectedPath) return
    const path = presentation.modelPath(props.selectedPath)
    const item = model.getItem(path)
    if (!item || item.isDirectory()) return
    syncing.current = true
    for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect()
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) {
      const folder = model.getItem(`${segments.slice(0, index).join('/')}/`)
      if (folder !== null && 'expand' in folder) folder.expand()
    }
    item.select()
    model.scrollToPath(path, { offset: 'nearest' })
    syncing.current = false
  }, [model, presentation, props.selectedPath])
  const allExpanded = useFileTreeSelector(model, current =>
    presentation.directories.every(path => {
      const item = current.getItem(path)
      return item !== null && 'isExpanded' in item && item.isExpanded()
    }),
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {actionError && (
        <p role="alert" className="text-destructive px-2 py-1 text-xs">
          {actionError}
        </p>
      )}
      <div className="border-border flex h-9 shrink-0 items-center justify-end border-b px-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={allExpanded ? 'Collapse all folders' : 'Expand all folders'}
          onClick={() => {
            for (const path of presentation.directories) {
              const item = model.getItem(path)
              if (item !== null && 'expand' in item) {
                if (allExpanded) item.collapse()
                else item.expand()
              }
            }
          }}
        >
          {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      </div>
      <FileTree
        model={model}
        aria-label="Changed files"
        className="min-h-0 flex-1 overflow-hidden"
        style={{ colorScheme: theme }}
        onClickCapture={event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
          const selected = model.getSelectedPaths()
          const path = selected.length === 1 ? selected[0] : undefined
          if (!path || path.endsWith('/')) return
          if (
            event.nativeEvent.composedPath().some(node => node instanceof HTMLElement && node.dataset.itemPath === path)
          )
            props.onSelectFile(presentation.selectionPath(path))
        }}
        renderContextMenu={(item, context) => (
          <DiffFileMenu
            key={item.path}
            scope={props.scope}
            path={presentation.selectionPath(item.path).replace(/\/$/, '')}
            directory={item.kind === 'directory'}
            onClose={context.close}
            onOpenFile={props.onOpenFile}
            onReferencePath={props.onReferencePath}
            onSelectFile={props.onSelectFile}
            onError={setActionError}
          />
        )}
      />
    </div>
  )
}

interface MenuProps extends Omit<Props, 'files' | 'selectedPath'> {
  readonly path: string
  readonly directory: boolean
  readonly onClose: () => void
  readonly onError: (message: string) => void
}

function DiffFileMenu(props: MenuProps): React.JSX.Element {
  const navigation = useCheckoutNavigation(props.scope, props.path)
  function action(run: () => void): void {
    props.onClose()
    run()
  }
  const menuClass = 'hover:bg-accent focus:bg-accent w-full rounded px-2 py-1.5 text-left text-xs outline-none'
  return (
    <div
      role="menu"
      aria-label={`Actions for ${props.path}`}
      className="bg-popover text-popover-foreground border-border min-w-44 rounded-lg border p-1 shadow-lg"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          props.onClose()
          return
        }
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
        const index = rows.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          rows[(index + 1) % rows.length]?.focus()
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          rows[(index + rows.length - 1) % rows.length]?.focus()
        }
      }}
    >
      {!props.directory && (
        <>
          <button role="menuitem" className={menuClass} onClick={() => action(() => props.onOpenFile?.(props.path))}>
            Open file
          </button>
          <button role="menuitem" className={menuClass} onClick={() => action(() => props.onSelectFile(props.path))}>
            Reveal changes
          </button>
        </>
      )}
      <button
        role="menuitem"
        className={menuClass}
        onClick={() =>
          action(() => {
            void navigator.clipboard.writeText(props.path).catch(() => undefined)
          })
        }
      >
        Copy file path
      </button>
      <button
        role="menuitem"
        className={menuClass}
        onClick={() =>
          action(() => {
            void navigator.clipboard.writeText(`@${props.path}`).catch(() => undefined)
          })
        }
      >
        Copy mention
      </button>
      <button role="menuitem" className={menuClass} onClick={() => action(() => props.onReferencePath?.(props.path))}>
        Add to chat
      </button>
      <button
        role="menuitem"
        className={menuClass}
        onClick={() =>
          action(() => {
            void navigation.open().then(ok => {
              if (!ok) props.onError('Could not open this file in the editor. Try again.')
            })
          })
        }
      >
        Open in editor
      </button>
      <button
        role="menuitem"
        className={menuClass}
        onClick={() =>
          action(() => {
            void navigation.reveal().then(ok => {
              if (!ok) props.onError('Could not reveal this path. Try again.')
            })
          })
        }
      >
        Reveal in file manager
      </button>
    </div>
  )
}
