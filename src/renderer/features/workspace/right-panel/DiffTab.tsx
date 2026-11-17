import type { CodeViewHandle } from '@pierre/diffs/react'
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FlaskConicalOff,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Pilcrow,
  RefreshCw,
  Rows3,
  Search,
  WrapText,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/renderer/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { CheckoutScope, DiffSourceSelector } from '@/shared/schemas/checkout-inspection.js'

import type { ReviewAnnotationGroup } from '../review/AnnotationComment.js'
import { useReviewComments } from '../review/use-review-comments.js'
import { CheckoutChangeActions } from './CheckoutChangeActions.js'
import { diffBranchChoices } from './diff-branch-choices.js'
import { useDiffCommits, useDiffReviewPatches } from './diff-review-queries.js'
import {
  collapsedDiffFileKeys,
  DIFF_PREFERENCES_KEY,
  diffReviewSectionId,
  isTestDiffPath,
  readDiffPreferences,
  readDiffReviewSection,
  readExpandedDiffs,
  shownDiffFiles,
  writeExpandedDiffs,
} from './diff-review-state.js'
import { diffFileKey } from './diff-tree.js'
import { DiffFileTree } from './DiffFileTree.js'
import { DiffReviewCodeView } from './DiffReviewCodeView.js'
import { ExplorerPane } from './ExplorerPane.js'
import { ChangeStats, InspectionNotice } from './inspection-ui.js'
import { browserStorage } from './right-panel-state.js'
import { useCheckoutBranches, useCheckoutDiffPreview } from './use-checkout-inspection.js'

type ScopeKind = 'working-tree' | 'branch-range' | 'staged' | 'commit'
const SCOPE_LABELS: Record<ScopeKind, string> = {
  'working-tree': 'Uncommitted changes',
  'branch-range': 'Branch changes',
  staged: 'Staged changes',
  commit: 'Commit',
}

export interface DiffTabProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly onReferencePath?: ((path: string) => void) | undefined
}

export function DiffTab(props: DiffTabProps): React.JSX.Element {
  const scope = useMemo(
    () => ({
      projectId: props.scope.projectId,
      ...(props.scope.checkoutId ? { checkoutId: props.scope.checkoutId } : {}),
    }),
    [props.scope.projectId, props.scope.checkoutId],
  )
  const [localRevision, setLocalRevision] = useState(0)
  const revision = props.revision + localRevision
  const [scopeKind, setScopeKind] = useState<ScopeKind>('working-tree')
  const [baseRef, setBaseRef] = useState<string | null>(null)
  const [commit, setCommit] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [preferences, setPreferences] = useState(() => readDiffPreferences(browserStorage()))
  const [searchRequest, setSearchRequest] = useState(0)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [showGitActions, setShowGitActions] = useState(false)
  const viewer = useRef<CodeViewHandle<ReviewAnnotationGroup, undefined>>(null)
  const review = useReviewComments()
  const pendingReveal = useRef<{ readonly path: string; readonly line: number; readonly sectionId: string } | null>(
    null,
  )
  const selector = useMemo<DiffSourceSelector>(() => {
    const ignoreWhitespace = preferences.ignoreWhitespace
    if (scopeKind === 'commit' && commit) return { kind: 'commit', commit, ignoreWhitespace }
    if (scopeKind === 'staged') return { kind: 'staged', ignoreWhitespace }
    if (scopeKind === 'branch-range') return { kind: 'branch-range', ...(baseRef ? { baseRef } : {}), ignoreWhitespace }
    return { kind: 'working-tree', ignoreWhitespace }
  }, [scopeKind, commit, baseRef, preferences.ignoreWhitespace])
  const preview = useCheckoutDiffPreview(scope, selector, revision)
  const source = preview.data
  const patches = useDiffReviewPatches(scope, source, revision, preferences.ignoreWhitespace)
  const commits = useDiffCommits(scope, sourceMenuOpen, revision)
  const collapseKey = JSON.stringify([scope, scopeKind, baseRef, commit])
  const storedExpanded = useMemo(() => readExpandedDiffs(browserStorage(), collapseKey), [collapseKey])
  const [folds, setFolds] = useState<{ readonly key: string; readonly values: ReadonlySet<string> }>(() => ({
    key: collapseKey,
    values: storedExpanded,
  }))
  const expanded = folds.key === collapseKey ? folds.values : storedExpanded
  const collapsed = useMemo(() => collapsedDiffFileKeys(source?.files ?? [], expanded), [source, expanded])
  const visibleFiles = useMemo(
    () => shownDiffFiles(source?.files ?? [], preferences.hideTests, selectedPath),
    [source, preferences.hideTests, selectedPath],
  )
  const sectionId = source ? diffReviewSectionId(scope, source, preferences.ignoreWhitespace) : ''
  const allCollapsed = visibleFiles.length > 0 && visibleFiles.every(file => collapsed.has(diffFileKey(file)))
  const testCount = source?.files.filter(file => isTestDiffPath(file.path)).length ?? 0
  const totals = visibleFiles.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )

  useEffect(() => {
    try {
      localStorage.setItem(DIFF_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      /* Preferences remain local. */
    }
  }, [preferences])
  useEffect(() => {
    writeExpandedDiffs(browserStorage(), collapseKey, expanded)
  }, [collapseKey, expanded])

  function updateExpanded(next: ReadonlySet<string>): void {
    setFolds({ key: collapseKey, values: next })
  }
  function unfold(key: string): void {
    if (!collapsed.has(key)) return
    updateExpanded(new Set(expanded).add(key))
  }
  function toggle(key: string): void {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    updateExpanded(next)
  }
  function toggleAll(): void {
    const next = new Set(expanded)
    for (const file of visibleFiles) {
      const key = diffFileKey(file)
      if (allCollapsed) next.add(key)
      else next.delete(key)
    }
    updateExpanded(next)
  }
  function reveal(path: string): void {
    const file = source?.files.find(candidate => candidate.path === path)
    if (!file) return
    setSelectedPath(path)
    unfold(diffFileKey(file))
    patches.requestFile(path)
    requestAnimationFrame(() => viewer.current?.scrollTo({ type: 'item', id: diffFileKey(file), align: 'start' }))
  }
  useEffect(() => {
    function onReveal(event: Event): void {
      const detail = (
        event as CustomEvent<{ ownerKey: string; path: string; line: number; sectionId: string; mode: string }>
      ).detail
      if (!detail || detail.mode !== 'diff' || detail.ownerKey !== review.ownerKey) return
      const target = readDiffReviewSection(detail.sectionId)
      if (!target || target.scope.projectId !== scope.projectId || target.scope.checkoutId !== scope.checkoutId) return
      pendingReveal.current = detail
      setScopeKind(target.source.kind)
      setBaseRef(target.source.kind === 'branch-range' ? (target.source.baseRef ?? null) : null)
      setCommit(target.source.kind === 'commit' ? target.source.commit : null)
      setPreferences(previous => ({ ...previous, ignoreWhitespace: target.source.ignoreWhitespace ?? false }))
      setSelectedPath(detail.path)
    }
    window.addEventListener('watchtower:reveal-review-comment', onReveal)
    return () => window.removeEventListener('watchtower:reveal-review-comment', onReveal)
  }, [review.ownerKey, scope])
  useEffect(() => {
    const pending = pendingReveal.current
    if (!pending || pending.sectionId !== sectionId) return
    const file = source?.files.find(candidate => candidate.path === pending.path)
    if (!file) return
    patches.requestFile(file.path)
    const key = diffFileKey(file)
    if (collapsed.has(key)) {
      const next = new Set(expanded)
      next.add(key)
      setFolds({ key: collapseKey, values: next })
      return
    }
    if (!patches.files.has(key)) return
    pendingReveal.current = null
    const frame = requestAnimationFrame(() =>
      viewer.current?.scrollTo({ type: 'line', id: key, lineNumber: pending.line, align: 'center' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [sectionId, source, patches, collapsed, expanded, collapseKey])

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDownCapture={event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          setSearchRequest(value => value + 1)
        }
      }}
    >
      <div className="border-border flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1">
        <DropdownMenu open={sourceMenuOpen} onOpenChange={setSourceMenuOpen}>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="h-7 min-w-0 gap-1 text-xs" aria-label="Diff source" />}
          >
            <span className="truncate">
              {scopeKind === 'commit' && commit ? `Commit ${commit.slice(0, 7)}` : SCOPE_LABELS[scopeKind]}
            </span>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72">
            {(['working-tree', 'staged', 'branch-range'] as const).map(kind => (
              <DropdownMenuItem
                key={kind}
                onClick={() => {
                  setScopeKind(kind)
                  setSelectedPath(null)
                }}
              >
                {scopeKind === kind && <Check className="size-3.5" />} {SCOPE_LABELS[kind]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Commits</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-80">
                <DropdownMenuLabel>Recent commits</DropdownMenuLabel>
                {commits?.data?.items.map(item => (
                  <DropdownMenuItem
                    key={item.hash}
                    title={item.subject}
                    onClick={() => {
                      setScopeKind('commit')
                      setCommit(item.hash)
                      setSelectedPath(null)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.subject}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">{item.hash.slice(0, 7)}</span>
                  </DropdownMenuItem>
                ))}
                {commits?.error && <DropdownMenuItem disabled>{commits.error}</DropdownMenuItem>}
                {!commits && <DropdownMenuItem disabled>Loading commits...</DropdownMenuItem>}
                {commits?.data?.items.length === 0 && (
                  <DropdownMenuItem disabled>No commits on this branch.</DropdownMenuItem>
                )}
                {commits?.data?.truncated && (
                  <DropdownMenuItem disabled>Showing the latest 100 commits.</DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {scopeKind === 'branch-range' && (
          <>
            <GitBranch className="text-muted-foreground size-3" />
            <span className="text-muted-foreground max-w-28 truncate text-[11px]">{source?.headRef ?? 'HEAD'} vs</span>
            <BaseRefPicker
              scope={scope}
              revision={revision}
              current={source?.baseRef ?? baseRef}
              onSelect={setBaseRef}
            />
          </>
        )}
      </div>
      <div className="border-border flex min-h-9 shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1">
        <span className="text-muted-foreground mr-auto text-[11px]">
          {visibleFiles.length} {visibleFiles.length === 1 ? 'file' : 'files'}
        </span>
        {source && <ChangeStats {...totals} />}
        <DiffAction label="Refresh diff" onClick={() => setLocalRevision(value => value + 1)}>
          <RefreshCw />
        </DiffAction>
        <DiffAction label={allCollapsed ? 'Expand all files' : 'Collapse all files'} onClick={toggleAll}>
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </DiffAction>
        <div className="border-border mx-1 flex rounded-md border p-0.5" role="group" aria-label="Diff layout">
          <DiffAction
            label="Stacked diff view"
            pressed={preferences.layout === 'unified'}
            onClick={() => setPreferences(previous => ({ ...previous, layout: 'unified' }))}
          >
            <Rows3 />
          </DiffAction>
          <DiffAction
            label="Split diff view"
            pressed={preferences.layout === 'split'}
            onClick={() => setPreferences(previous => ({ ...previous, layout: 'split' }))}
          >
            <Columns2 />
          </DiffAction>
        </div>
        <DiffAction
          label={preferences.wrap ? 'Disable diff line wrapping' : 'Enable diff line wrapping'}
          pressed={preferences.wrap}
          onClick={() => setPreferences(previous => ({ ...previous, wrap: !previous.wrap }))}
        >
          <WrapText />
        </DiffAction>
        <DiffAction
          label={preferences.ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
          pressed={preferences.ignoreWhitespace}
          onClick={() => setPreferences(previous => ({ ...previous, ignoreWhitespace: !previous.ignoreWhitespace }))}
        >
          <Pilcrow />
        </DiffAction>
        {testCount > 0 && (
          <DiffAction
            label={preferences.hideTests ? `Show ${testCount} hidden test files` : 'Hide test files'}
            pressed={preferences.hideTests}
            onClick={() => setPreferences(previous => ({ ...previous, hideTests: !previous.hideTests }))}
          >
            <FlaskConicalOff />
          </DiffAction>
        )}
        <DiffAction
          label={preferences.showTree ? 'Hide file tree' : 'Show file tree'}
          pressed={preferences.showTree}
          onClick={() => setPreferences(previous => ({ ...previous, showTree: !previous.showTree }))}
        >
          <FolderTree />
        </DiffAction>
        <DiffAction label="Find in diff" onClick={() => setSearchRequest(value => value + 1)}>
          <Search />
        </DiffAction>
        {(scopeKind === 'working-tree' || scopeKind === 'staged') && (
          <DiffAction label="Git actions" pressed={showGitActions} onClick={() => setShowGitActions(!showGitActions)}>
            <GitCommitHorizontal />
          </DiffAction>
        )}
      </div>
      {showGitActions && (scopeKind === 'working-tree' || scopeKind === 'staged') && (
        <CheckoutChangeActions
          scope={scope}
          revision={revision}
          selectedPath={selectedPath}
          onChanged={() => setLocalRevision(value => value + 1)}
        />
      )}
      {preview.error ? (
        <InspectionNotice tone="error">{preview.error.message}</InspectionNotice>
      ) : preview.loading || !source ? (
        <InspectionNotice>Loading changes...</InspectionNotice>
      ) : source.files.length === 0 ? (
        <InspectionNotice>No changes in this selection.</InspectionNotice>
      ) : (
        <>
          {source.truncated && (
            <p className="text-muted-foreground border-border border-b px-3 py-1 text-xs">
              Showing the first 2,000 files. Totals are incomplete.
            </p>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
            {visibleFiles.length === 0 ? (
              <InspectionNotice>All changed files are hidden by the test filter.</InspectionNotice>
            ) : (
              <DiffReviewCodeView
                key={`${review.ownerKey}:${sectionId}`}
                scope={scope}
                files={visibleFiles}
                patches={patches.files}
                sectionId={sectionId}
                searchRequest={searchRequest}
                collapsed={collapsed}
                wrap={preferences.wrap}
                layout={preferences.layout}
                onToggleFile={toggle}
                onUnfoldFile={unfold}
                onOpenFile={props.onOpenFile}
                onReferencePath={props.onReferencePath}
                onRequestFile={patches.requestFile}
                onRetryFile={file => {
                  void patches.request(file, true).catch(() => undefined)
                }}
                onLoadNext={patches.loadNext}
                remaining={patches.missing.length}
                viewerRef={viewer}
              />
            )}
            {preferences.showTree && (
              <ExplorerPane storageKey="watchtower.workspace.diff-tree-width.v1">
                <DiffFileTree
                  scope={scope}
                  files={visibleFiles}
                  selectedPath={selectedPath}
                  onSelectFile={reveal}
                  onOpenFile={props.onOpenFile}
                  onReferencePath={props.onReferencePath}
                />
              </ExplorerPane>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function DiffAction({
  label,
  pressed,
  onClick,
  children,
}: {
  readonly label: string
  readonly pressed?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            className={pressed ? 'bg-muted text-foreground' : undefined}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

interface BaseRefPickerProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly current: string | null
  readonly onSelect: (name: string | null) => void
}

/** Chooses the base branch for the Branch scope from local and remote branches. */
function BaseRefPicker({ scope, revision, current, onSelect }: BaseRefPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const branches = useCheckoutBranches(scope, open, revision)
  const items = diffBranchChoices(branches.data?.items ?? [])
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
          {branches.error && (
            <p role="alert" className="text-destructive p-2 text-xs">
              {branches.error.message}
            </p>
          )}
          <div className="border-border text-muted-foreground flex justify-between border-b px-3 py-1.5 text-[10px]">
            <span>Branch</span>
            <span>Remote</span>
          </div>
          <CommandList className="max-h-64">
            <CommandEmpty>{branches.loading ? 'Loading branches…' : 'No matching branches.'}</CommandEmpty>
            <CommandItem
              value="Automatic"
              onSelect={() => {
                onSelect(null)
                setOpen(false)
              }}
            >
              Automatic
            </CommandItem>
            {items.map(item => (
              <CommandItem
                key={item.label}
                value={`${item.label} ${item.local ?? ''} ${item.remote ?? ''}`}
                onSelect={() => {
                  onSelect(current === item.remote ? item.remote : (item.local ?? item.remote))
                  setOpen(false)
                }}
                className="text-[11.5px]"
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.local && item.remote ? (
                  <button
                    type="button"
                    role="switch"
                    aria-label={`Use remote version of ${item.label}`}
                    aria-checked={current === item.remote}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation()
                      onSelect(current === item.remote ? item.local : item.remote)
                    }}
                    className={`border-border h-3.5 w-6 shrink-0 rounded-full border p-px ${current === item.remote ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span
                      className={`bg-background block size-2.5 rounded-full transition-transform ${current === item.remote ? 'translate-x-2.5' : ''}`}
                    />
                  </button>
                ) : item.remote ? (
                  <Check role="img" aria-label="Remote only" className="text-muted-foreground size-3 shrink-0" />
                ) : null}
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
