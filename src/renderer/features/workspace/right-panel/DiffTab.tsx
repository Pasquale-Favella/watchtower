import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  GitBranch,
  WrapText,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { SegTabs } from '@/renderer/components/SegTabs'
import { Button } from '@/renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/renderer/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { cn } from '@/renderer/shared/lib/utils'
import type {
  CheckoutBranchList,
  CheckoutScope,
  DiffFile,
  DiffSource,
  DiffSourceSelector,
  FilePatch,
} from '@/shared/schemas/checkout-inspection.js'

import { buildDiffTree, diffFileKey, type DiffTreeNode, folderPaths } from './diff-tree.js'
import { ChangeStats, InspectionNotice } from './inspection-ui.js'
import { formatCompactCount, parseUnifiedDiff } from './unified-diff.js'
import {
  type InspectionState,
  useCheckoutBranches,
  useCheckoutDiffPreview,
  useCheckoutFilePatch,
} from './use-checkout-inspection.js'

type ScopeKind = 'working-tree' | 'branch-range'

const SCOPE_OPTIONS = [
  { value: 'working-tree', label: 'Uncommitted' },
  { value: 'branch-range', label: 'Branch' },
]
const STATUS_LETTER: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
}
const STATUS_TONE: Record<DiffFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-destructive',
  renamed: 'text-muted-foreground',
}
/** Rows beyond this count render behind an explicit control, so a large patch cannot stall the panel. */
const RENDERED_ROW_LIMIT = 2000

export interface DiffTabProps {
  readonly scope: CheckoutScope
  readonly revision: number
}

function selectorFor(kind: ScopeKind, baseRef: string | null): DiffSourceSelector {
  if (kind === 'working-tree') return { kind: 'working-tree' }
  return baseRef === null ? { kind: 'branch-range' } : { kind: 'branch-range', baseRef }
}

/** The path a row shows: `old → new` for a rename. */
function fileLabel(file: DiffFile): string {
  return file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`
}

function totalsOf(files: readonly DiffFile[]) {
  return files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )
}

/** Changes in the checkout: uncommitted work, or the branch against a chosen base, with a per-file patch. */
export function DiffTab({ scope, revision }: DiffTabProps) {
  const [scopeKind, setScopeKind] = useState<ScopeKind>('working-tree')
  const [baseRef, setBaseRef] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [wrap, setWrap] = useState(false)

  const preview = useCheckoutDiffPreview(scope, selectorFor(scopeKind, baseRef), revision)
  const source = preview.data
  const tree = useMemo(() => buildDiffTree(source?.files ?? []), [source])
  const selected = source?.files.find(file => diffFileKey(file) === selectedKey) ?? null
  // The patch request repeats the source's resolved base, so it always matches the list it came from.
  const patch = useCheckoutFilePatch(
    scope,
    source && selected
      ? { source: selectorFor(source.kind, source.baseRef), path: selected.path, previousPath: selected.previousPath }
      : null,
    revision,
  )

  const toggleFolder = (path: string, open: boolean) =>
    setCollapsed(previous => {
      const next = new Set(previous)
      if (open) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex flex-wrap items-center gap-1.5 border-b px-2.5 py-2">
        <SegTabs
          options={SCOPE_OPTIONS}
          value={scopeKind}
          onChange={value => {
            setScopeKind(value === 'branch-range' ? 'branch-range' : 'working-tree')
            setSelectedKey(null)
          }}
        />
        {scopeKind === 'branch-range' ? (
          <BaseRefPicker
            scope={scope}
            revision={revision}
            current={source?.baseRef ?? baseRef}
            onSelect={name => {
              setBaseRef(name)
              setSelectedKey(null)
            }}
          />
        ) : null}
      </div>
      <DiffBody
        scope={scope}
        revision={revision}
        preview={preview}
        source={source}
        tree={tree}
        collapsed={collapsed}
        onToggleFolder={toggleFolder}
        onCollapseAll={() => setCollapsed(new Set(folderPaths(tree)))}
        onExpandAll={() => setCollapsed(new Set())}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        patch={patch}
        selected={selected}
        wrap={wrap}
        onWrapChange={setWrap}
      />
    </div>
  )
}

interface DiffBodyProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly preview: InspectionState<DiffSource>
  readonly source: DiffSource | null | undefined
  readonly tree: readonly DiffTreeNode[]
  readonly collapsed: ReadonlySet<string>
  readonly onToggleFolder: (path: string, open: boolean) => void
  readonly onCollapseAll: () => void
  readonly onExpandAll: () => void
  readonly selectedKey: string | null
  readonly onSelect: (key: string) => void
  readonly patch: InspectionState<FilePatch>
  readonly selected: DiffFile | null
  readonly wrap: boolean
  readonly onWrapChange: (wrap: boolean) => void
}

function DiffBody(props: DiffBodyProps) {
  const { preview, source } = props
  if (preview.error) return <InspectionNotice tone="error">{preview.error.message}</InspectionNotice>
  if (preview.loading || !source) return <InspectionNotice>Loading changes…</InspectionNotice>
  if (source.files.length === 0)
    return (
      <InspectionNotice>
        {source.kind === 'working-tree' ? 'No uncommitted changes' : `No changes since ${source.baseRef ?? 'base'}`}
      </InspectionNotice>
    )
  const totals = totalsOf(source.files)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-2.5 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate">
          {source.truncated ? 'First ' : ''}
          {source.files.length.toLocaleString()} {source.files.length === 1 ? 'file' : 'files'}
        </span>
        <ChangeStats additions={totals.additions} deletions={totals.deletions} />
        <Button variant="ghost" size="icon-xs" aria-label="Expand all folders" onClick={props.onExpandAll}>
          <ChevronsUpDown />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Collapse all folders" onClick={props.onCollapseAll}>
          <ChevronsDownUp />
        </Button>
      </div>
      {source.truncated ? (
        <p className="border-border text-muted-foreground border-b px-2.5 py-1 text-[10.5px]">
          Showing the first 2,000 files.
        </p>
      ) : null}
      <div className="border-border max-h-[42%] min-h-20 shrink-0 overflow-auto border-b py-1">
        <TreeRows
          nodes={props.tree}
          depth={0}
          collapsed={props.collapsed}
          onToggleFolder={props.onToggleFolder}
          selectedKey={props.selectedKey}
          onSelect={props.onSelect}
        />
      </div>
      <PatchView file={props.selected} patch={props.patch} wrap={props.wrap} onWrapChange={props.onWrapChange} />
    </div>
  )
}

interface TreeRowsProps {
  readonly nodes: readonly DiffTreeNode[]
  readonly depth: number
  readonly collapsed: ReadonlySet<string>
  readonly onToggleFolder: (path: string, open: boolean) => void
  readonly selectedKey: string | null
  readonly onSelect: (key: string) => void
}

function TreeRows(props: TreeRowsProps) {
  return props.nodes.map(node =>
    node.kind === 'folder' ? (
      <FolderRow key={`folder:${node.path}`} node={node} {...props} />
    ) : (
      <FileRow
        key={`file:${diffFileKey(node.file)}`}
        name={node.name}
        file={node.file}
        depth={props.depth}
        selected={props.selectedKey === diffFileKey(node.file)}
        onSelect={props.onSelect}
      />
    ),
  )
}

type FolderNode = Extract<DiffTreeNode, { kind: 'folder' }>

function FolderRow({ node, ...props }: Omit<TreeRowsProps, 'nodes'> & { readonly node: FolderNode }) {
  const open = !props.collapsed.has(node.path)
  const Chevron = open ? ChevronDown : ChevronRight
  const Glyph = open ? FolderOpen : Folder
  return (
    <Collapsible open={open} onOpenChange={next => props.onToggleFolder(node.path, next)}>
      <CollapsibleTrigger
        className="hover:bg-muted flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px]"
        style={{ paddingLeft: 8 + props.depth * 12 }}
      >
        <Chevron className="text-muted-foreground size-3 shrink-0" aria-hidden />
        <Glyph className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <ChangeStats additions={node.additions} deletions={node.deletions} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TreeRows {...props} nodes={node.children} depth={props.depth + 1} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function FileRow({
  name,
  file,
  depth,
  selected,
  onSelect,
}: {
  readonly name: string
  readonly file: DiffFile
  readonly depth: number
  readonly selected: boolean
  readonly onSelect: (key: string) => void
}) {
  const title = fileLabel(file)
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={title}
      onClick={() => onSelect(diffFileKey(file))}
      className={cn(
        'hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px]',
        selected && 'bg-muted text-foreground',
      )}
      style={{ paddingLeft: 8 + depth * 12 + 16 }}
    >
      <span className={cn('w-3 shrink-0 text-center font-mono text-[10.5px] font-semibold', STATUS_TONE[file.status])}>
        <span aria-hidden>{STATUS_LETTER[file.status]}</span>
        <span className="sr-only">{STATUS_LABEL[file.status]}</span>
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {file.binary ? (
        <span className="text-muted-foreground shrink-0 text-[10px]">binary</span>
      ) : (
        <ChangeStats additions={file.additions} deletions={file.deletions} />
      )}
    </button>
  )
}

interface PatchViewProps {
  readonly file: DiffFile | null
  readonly patch: InspectionState<FilePatch>
  readonly wrap: boolean
  readonly onWrapChange: (wrap: boolean) => void
}

function PatchView({ file, patch, wrap, onWrapChange }: PatchViewProps) {
  if (file === null) return <InspectionNotice>Select a file to see its changes.</InspectionNotice>
  const title = fileLabel(file)
  const data = patch.data
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={title}>
          {title}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          title="Wrap lines"
          onClick={() => onWrapChange(!wrap)}
        >
          <WrapText />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {patch.error ? (
          <InspectionNotice tone="error">{patch.error.message}</InspectionNotice>
        ) : patch.loading || data === null ? (
          <InspectionNotice>Loading diff…</InspectionNotice>
        ) : data.binary ? (
          <InspectionNotice>Binary file. Content is not shown.</InspectionNotice>
        ) : data.patch.trim() === '' ? (
          <InspectionNotice>No textual changes.</InspectionNotice>
        ) : (
          <>
            <UnifiedPatch patch={data.patch} wrap={wrap} />
            {data.truncated ? (
              <p className="text-muted-foreground px-2.5 py-2 text-[10.5px]">Diff truncated at 1 MiB.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

interface PatchRow {
  readonly key: string
  readonly kind: 'hunk' | 'addition' | 'deletion' | 'context' | 'note'
  readonly oldNumber: number | null
  readonly newNumber: number | null
  readonly text: string
}

const ROW_TONE: Record<PatchRow['kind'], string> = {
  hunk: 'bg-muted text-muted-foreground',
  addition: 'bg-success/15',
  deletion: 'bg-destructive/15',
  context: '',
  note: 'text-muted-foreground italic',
}
const SIGN: Record<PatchRow['kind'], string> = { hunk: '', addition: '+', deletion: '-', context: ' ', note: '' }

/** Renders a unified patch with old and new line numbers. Each hunk header is its own row. */
function UnifiedPatch({ patch, wrap }: { readonly patch: string; readonly wrap: boolean }) {
  const rows = useMemo<PatchRow[]>(() => {
    const result: PatchRow[] = []
    parseUnifiedDiff(patch).hunks.forEach((hunk, hunkIndex) => {
      result.push({ key: `h${hunkIndex}`, kind: 'hunk', oldNumber: null, newNumber: null, text: hunk.header })
      hunk.lines.forEach((line, lineIndex) =>
        result.push({
          key: `h${hunkIndex}l${lineIndex}`,
          kind: line.kind,
          oldNumber: line.oldNumber,
          newNumber: line.newNumber,
          text: line.text,
        }),
      )
    })
    return result
  }, [patch])
  const [limit, setLimit] = useState(RENDERED_ROW_LIMIT)
  const visible = rows.slice(0, limit)
  return (
    <div className={cn('font-mono text-[11px] leading-5', wrap ? '' : 'w-max min-w-full')}>
      {visible.map(row =>
        row.kind === 'hunk' ? (
          <div key={row.key} className={cn('px-2 py-0.5', ROW_TONE.hunk, wrap ? 'break-all' : 'whitespace-pre')}>
            {row.text}
          </div>
        ) : (
          <div key={row.key} className={cn('flex', ROW_TONE[row.kind])}>
            <span className="text-muted-foreground w-10 shrink-0 px-1 text-right tabular-nums select-none">
              {row.oldNumber ?? ''}
            </span>
            <span className="text-muted-foreground w-10 shrink-0 px-1 text-right tabular-nums select-none">
              {row.newNumber ?? ''}
            </span>
            <span className="w-4 shrink-0 text-center select-none">{SIGN[row.kind]}</span>
            <span className={cn('min-w-0 flex-1 pr-3', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
              {row.text}
            </span>
          </div>
        ),
      )}
      {rows.length > limit ? (
        <Button variant="ghost" size="sm" className="m-2 text-[11.5px]" onClick={() => setLimit(rows.length)}>
          Show all {formatCompactCount(rows.length)} lines
        </Button>
      ) : null}
    </div>
  )
}

interface BaseRefPickerProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly current: string | null
  readonly onSelect: (name: string) => void
}

/** The badge on a branch row: `remote` for remote refs, `current` for the checked-out branch. */
function branchBadge(item: CheckoutBranchList['items'][number]): string {
  if (item.kind === 'remote') return 'remote'
  return item.current ? 'current' : ''
}

/** Chooses the base branch for the Branch scope from local and remote branches. */
function BaseRefPicker({ scope, revision, current, onSelect }: BaseRefPickerProps) {
  const [open, setOpen] = useState(false)
  const branches = useCheckoutBranches(scope, open, revision)
  const items = branches.data?.items ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Base branch"
            className="border-border h-7 max-w-48 min-w-0 gap-1.5 text-[11.5px] font-normal"
          />
        }
      >
        <GitBranch className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{current ?? 'Default base'}</span>
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search branches…" aria-label="Search branches" />
          <CommandList className="max-h-64">
            <CommandEmpty>{branches.loading ? 'Loading branches…' : 'No matching branches.'}</CommandEmpty>
            {items.map(item => (
              <CommandItem
                key={`${item.kind}:${item.name}`}
                value={item.name}
                onSelect={() => {
                  onSelect(item.name)
                  setOpen(false)
                }}
                className="text-[11.5px]"
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-muted-foreground shrink-0 text-[10px]">{branchBadge(item)}</span>
                {item.name === current ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
              </CommandItem>
            ))}
          </CommandList>
          {branches.data?.truncated ? (
            <p className="text-muted-foreground border-border border-t px-2 py-1.5 text-[10.5px]">
              Showing the first 200 branches. Search to narrow the list.
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
