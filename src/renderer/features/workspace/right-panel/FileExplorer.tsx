import type { FileTreeBatchOperation } from '@pierre/trees'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from '@pierre/trees/react'
import { ChevronsDownUp, ChevronsUpDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { useCheckoutNavigation } from '../checkout-navigation/use-checkout-navigation.js'
import { usePromptContextSearch } from '../prompt-context-hooks.js'
import { filePromptToken } from '../prompt-editor.js'
import { useCodeTheme } from '../review/use-code-theme.js'
import { reconcileExpandedDirectories } from './directory-tree-loading.js'
import { InspectionNotice } from './inspection-ui.js'
import { useDirectoryTree } from './use-directory-tree.js'

const TREE_CSS = `
  :host { --trees-bg-override: transparent; --trees-fg-override: var(--foreground);
    --trees-selected-bg-override: var(--muted); --trees-hover-bg-override: var(--muted);
    --trees-border-color-override: var(--border); --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px; }
  button[data-type='item'] { border-radius: var(--radius-sm); }
`
const IGNORED = new Set(['node_modules', '.git', 'vendor', 'dist', 'out', 'build'])

export interface FileExplorerProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly root?: string | undefined
  readonly selectedPath?: string | null | undefined
  readonly onOpenFile: (path: string) => void
  readonly onReferencePath: (path: string) => void
}

export function FileExplorer({ root = '', ...props }: FileExplorerProps): React.JSX.Element {
  const theme = useCodeTheme()
  const directory = useDirectoryTree(props.scope, root, props.revision)
  const loadDirectory = directory.load
  const [query, setQuery] = useState('')
  const [expandAll, setExpandAll] = useState(false)
  const syncing = useRef(false)
  const traversing = useRef(false)
  const dragging = useRef(false)
  const callbacks = useRef(props)
  const knownPaths = useRef<ReadonlySet<string> | null>(null)
  const expandedPaths = useRef(new Set<string>())
  const revealedSelection = useRef<string | null>(null)
  useEffect(() => {
    callbacks.current = props
  }, [props])
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const navigation = useCheckoutNavigation(props.scope, menuPath)
  const request = useMemo(
    () =>
      query.trim()
        ? {
            projectId: props.scope.projectId,
            ...(props.scope.checkoutId ? { checkoutId: props.scope.checkoutId } : {}),
            kind: 'file' as const,
            query: query.trim().slice(0, 256),
          }
        : null,
    [props.scope.projectId, props.scope.checkoutId, query],
  )
  const search = usePromptContextSearch(request)
  const ignoredDirectories = useMemo(() => {
    const ignored = new Set<string>()
    for (const listing of directory.listings.values()) {
      for (const entry of listing.entries) {
        if (entry.kind === 'directory' && entry.ignored) ignored.add(`${entry.path}/`)
      }
    }
    return ignored
  }, [directory.listings])
  const entries = useMemo(() => {
    const paths = new Set<string>()
    const pending = [root]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const path = pending.pop()
      if (path === undefined || visited.has(path)) continue
      visited.add(path)
      const listing = directory.listings.get(path)
      if (!listing) continue
      for (const entry of listing.entries) paths.add(entry.path + (entry.kind === 'directory' ? '/' : ''))
      for (const entry of listing.entries) if (entry.kind === 'directory') pending.push(entry.path)
    }
    if (query.trim()) for (const entry of search.data?.items ?? []) if (entry.kind === 'file') paths.add(entry.path)
    return [...paths].filter(path => root === '' || path.startsWith(`${root}/`))
  }, [directory.listings, query, root, search.data])
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    flattenEmptyDirectories: true,
    density: 'compact',
    icons: { set: 'complete', colored: true },
    search: false,
    fileTreeSearchMode: 'hide-non-matches',
    unsafeCSS: TREE_CSS,
    composition: {
      contextMenu: { triggerMode: 'right-click', onOpen: item => setMenuPath(item.path.replace(/\/$/, '')) },
    },
    dragAndDrop: { canDrop: () => false },
    onSelectionChange: paths => {
      if (syncing.current || dragging.current) return
      const path = paths.at(-1)
      if (path && !path.endsWith('/')) callbacks.current.onOpenFile(path)
    },
  })
  const treeSearch = useFileTreeSearch(model)
  const noMatches = query.trim().length > 0 && treeSearch.matchingPaths.length === 0 && search.status !== 'loading'
  const autoExpandable = useCallback(
    (path: string): boolean => {
      return (
        path.endsWith('/') &&
        !path.split('/').some(segment => IGNORED.has(segment)) &&
        ![...ignoredDirectories].some(directory => path.startsWith(directory))
      )
    },
    [ignoredDirectories],
  )
  const allExpanded = useFileTreeSelector(model, current => {
    const folders = entries.filter(autoExpandable)
    return (
      folders.length > 0 &&
      folders.every(path => {
        const item = current.getItem(path)
        return item && 'isExpanded' in item && item.isExpanded()
      })
    )
  })

  useEffect(() => {
    const previous = knownPaths.current
    const next = new Set(entries)
    knownPaths.current = next
    syncing.current = true
    try {
      if (!previous) {
        model.resetPaths(entries)
        return
      }
      const updates: FileTreeBatchOperation[] = [...previous]
        .filter(path => !next.has(path))
        .sort((left, right) => right.length - left.length)
        .map(path => ({ type: 'remove', path, recursive: true }))
      for (const path of next) if (!previous.has(path)) updates.push({ type: 'add', path })
      if (updates.length > 0) model.batch(updates)
    } finally {
      syncing.current = false
    }
  }, [entries, model])
  useEffect(() => {
    if (query.trim()) model.setSearch(query)
    else model.closeSearch()
  }, [model, query])
  useEffect(() => {
    if (!expandAll || query.trim()) return
    for (const path of entries) {
      if (!autoExpandable(path)) continue
      const item = model.getItem(path)
      if (item && 'expand' in item && !item.isExpanded()) item.expand()
    }
  }, [autoExpandable, entries, expandAll, model, query])
  useEffect(() => {
    function loadExpanded(): void {
      if (query.trim() || traversing.current) return
      traversing.current = true
      try {
        const expanded = reconcileExpandedDirectories(entries, expandedPaths.current, path => {
          const item = model.getItem(path)
          return !!item && 'isExpanded' in item && item.isExpanded()
        })
        expandedPaths.current = new Set(expanded.paths)
        for (const path of expanded.newlyExpanded) void loadDirectory(path.slice(0, -1))
      } finally {
        traversing.current = false
      }
    }
    loadExpanded()
    return model.subscribe(loadExpanded)
  }, [loadDirectory, entries, model, query])
  useEffect(() => {
    if (!props.selectedPath) {
      revealedSelection.current = null
      return
    }
    const parts = props.selectedPath.split('/')
    for (let index = 1; index < parts.length; index++) void loadDirectory(parts.slice(0, index).join('/'))
  }, [loadDirectory, props.selectedPath])
  useEffect(() => {
    const selected = props.selectedPath
    if (!selected) {
      revealedSelection.current = null
      return
    }
    if (revealedSelection.current === selected || !entries.includes(selected)) return
    revealedSelection.current = selected
    if (model.getSelectedPaths().includes(selected)) return
    syncing.current = true
    const parts = selected.split('/')
    for (let index = 1; index < parts.length; index++) {
      const item = model.getItem(`${parts.slice(0, index).join('/')}/`)
      if (item && 'expand' in item) item.expand()
    }
    for (const path of model.getSelectedPaths()) if (path !== selected) model.getItem(path)?.deselect()
    model.getItem(selected)?.select()
    model.scrollToPath(selected, { focus: false })
    queueMicrotask(() => {
      syncing.current = false
    })
  }, [entries, model, props.selectedPath])

  function toggleAll(): void {
    const open = !(expandAll || allExpanded)
    setExpandAll(open)
    for (const path of entries) {
      if (!path.endsWith('/')) continue
      const item = model.getItem(path)
      if (!item || !('expand' in item)) continue
      if (open && autoExpandable(path)) item.expand()
      else item.collapse()
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-file-explorer>
      <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-1.5">
        <Button variant="ghost" size="icon-xs" aria-label="Refresh files" onClick={directory.refresh}>
          <RefreshCw className={directory.pending ? 'animate-spin' : ''} />
        </Button>
        <input
          type="search"
          value={query}
          aria-label="Search files"
          placeholder="Search files"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setQuery('')
              event.currentTarget.blur()
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={expandAll || allExpanded ? 'Collapse all folders' : 'Expand all folders'}
          onClick={toggleAll}
        >
          {expandAll || allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      </div>
      {(directory.error || search.error || navigation.error) && (
        <InspectionNotice tone="error">{directory.error ?? search.error ?? navigation.error}</InspectionNotice>
      )}
      {search.data?.truncated && query.trim() && (
        <InspectionNotice>More matches available. Refine your search.</InspectionNotice>
      )}
      {directory.listings.size === 0 && directory.pending && <InspectionNotice>Loading files…</InspectionNotice>}
      {noMatches && <InspectionNotice>No matching files.</InspectionNotice>}
      <FileTree
        model={model}
        aria-label="Checkout files"
        className="min-h-0 flex-1"
        style={{ colorScheme: theme, display: noMatches ? 'none' : undefined }}
        onDragStartCapture={event => {
          const row = event.nativeEvent
            .composedPath()
            .find(node => node instanceof HTMLElement && node.hasAttribute('data-item-path'))
          if (!(row instanceof HTMLElement)) return
          const path = row.getAttribute('data-item-path')?.replace(/\/$/, '')
          if (!path) return
          dragging.current = true
          const selected = model.getSelectedPaths()
          const paths = selected.includes(path) ? selected : [path]
          event.dataTransfer.setData('application/x-watchtower-file-reference', paths.map(filePromptToken).join(' '))
        }}
        onDragEnd={() => {
          dragging.current = false
        }}
        renderContextMenu={(item, context) => {
          const path = item.path.replace(/\/$/, '')
          function action(run: () => void): void {
            context.close()
            run()
          }
          const menuClass = 'hover:bg-accent flex w-full items-center rounded px-2 py-1.5 text-left text-xs'
          return (
            <div
              role="menu"
              className="border-border bg-popover text-popover-foreground min-w-44 rounded-md border p-1 shadow-md"
            >
              {!item.path.endsWith('/') && (
                <button role="menuitem" className={menuClass} onClick={() => action(() => props.onOpenFile(path))}>
                  Open file
                </button>
              )}
              {(['vscode', 'cursor', 'vscodium', 'system'] as const).map(editor => (
                <button
                  key={editor}
                  role="menuitem"
                  className={menuClass}
                  onClick={() =>
                    action(() => {
                      void navigation.open(editor)
                    })
                  }
                >
                  Open in {editor}
                </button>
              ))}
              <button
                role="menuitem"
                className={menuClass}
                onClick={() =>
                  action(() => {
                    void navigation.reveal()
                  })
                }
              >
                Reveal in file manager
              </button>
              <button
                role="menuitem"
                className={menuClass}
                onClick={() =>
                  action(() => {
                    void navigator.clipboard.writeText(path)
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
                    void navigator.clipboard.writeText(filePromptToken(path))
                  })
                }
              >
                Copy mention
              </button>
              <button role="menuitem" className={menuClass} onClick={() => action(() => props.onReferencePath(path))}>
                Add to chat
              </button>
            </div>
          )
        }}
      />
    </div>
  )
}
