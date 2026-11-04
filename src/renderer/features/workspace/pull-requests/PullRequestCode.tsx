import { useMemo, useState } from 'react'

import { SegTabs } from '@/renderer/components/SegTabs'
import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { WorkspacePullRequestDetail } from '@/shared/schemas/workspace-pull-requests.js'

import { parseUnifiedDiff, splitDiffRows } from '../right-panel/unified-diff.js'
import { usePullRequestDiff } from './use-pull-requests.js'

interface Props {
  readonly scope: CheckoutScope
  readonly detail: WorkspacePullRequestDetail
  readonly revision: number
  readonly path: string | null
  readonly onPathChange: (path: string) => void
  readonly onReference: (text: string) => void
  readonly onAddReviewComment: (path: string, line: number, side: 'LEFT' | 'RIGHT') => void
}

export function PullRequestCode(props: Props): React.JSX.Element {
  const { detail } = props
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [wrap, setWrap] = useState(false)
  const path = props.path ?? detail.files[0]?.path ?? null
  const diff = usePullRequestDiff(path ? { ...props.scope, number: detail.number, path } : null, props.revision)
  const parsed = useMemo(() => parseUnifiedDiff(diff.data?.patch ?? ''), [diff.data])
  const split = useMemo(() => splitDiffRows(parsed), [parsed])
  const [showAll, setShowAll] = useState(false)
  const maxRows = showAll ? Number.MAX_SAFE_INTEGER : 2000
  return (
    <section className="space-y-2" aria-label="Pull request code">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Pull request file"
          value={path ?? ''}
          onChange={event => {
            props.onPathChange(event.target.value)
            setShowAll(false)
          }}
          className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
        >
          {detail.files.map(file => (
            <option key={file.path} value={file.path}>
              {file.path} (+{file.additions} -{file.deletions})
            </option>
          ))}
        </select>
        <SegTabs
          value={layout}
          options={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
          onChange={value => setLayout(value === 'split' ? 'split' : 'unified')}
        />
        <Button size="xs" variant="ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          Wrap
        </Button>
      </div>
      {detail.filesTruncated && (
        <p className="text-muted-foreground text-xs">
          Showing {detail.files.length} of {detail.changedFiles} files returned by GitHub.
        </p>
      )}
      {diff.error && (
        <p role="alert" className="text-destructive text-xs">
          {diff.error}
        </p>
      )}
      {diff.loading && (
        <p role="status" className="text-muted-foreground text-xs">
          Loading pull request diff…
        </p>
      )}
      {diff.data && !diff.data.available && (
        <p className="text-muted-foreground text-xs">GitHub did not return a textual patch for this file.</p>
      )}
      {diff.data?.available && (
        <div className="border-border overflow-auto rounded-md border" aria-label="Pull request diff">
          <div className={cn('min-w-full font-mono text-[11px] leading-5', !wrap && 'w-max')}>
            {layout === 'unified'
              ? parsed.hunks.map((hunk, hunkIndex) => (
                  <div key={hunkIndex}>
                    <div className="bg-muted text-muted-foreground px-2">{hunk.header}</div>
                    {hunk.lines.slice(0, maxRows).map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          'flex',
                          line.kind === 'addition' && 'bg-success/15',
                          line.kind === 'deletion' && 'bg-destructive/15',
                        )}
                      >
                        <button
                          type="button"
                          className="text-muted-foreground w-10 shrink-0 px-1 text-right tabular-nums hover:underline"
                          title="Add review comment"
                          aria-label={`Review old line ${line.oldNumber ?? ''}`}
                          disabled={!line.oldNumber || !path}
                          onClick={() =>
                            path && line.oldNumber && props.onAddReviewComment(path, line.oldNumber, 'LEFT')
                          }
                        >
                          {line.oldNumber ?? ''}
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground w-10 shrink-0 px-1 text-right tabular-nums hover:underline"
                          title="Add review comment"
                          aria-label={`Review new line ${line.newNumber ?? ''}`}
                          disabled={!line.newNumber || !path}
                          onClick={() =>
                            path && line.newNumber && props.onAddReviewComment(path, line.newNumber, 'RIGHT')
                          }
                        >
                          {line.newNumber ?? ''}
                        </button>
                        <span
                          className={cn(
                            'min-w-0 flex-1 pr-2',
                            wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
                          )}
                        >
                          {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}
                          {line.text}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              : split.slice(0, maxRows).map((row, index) =>
                  row.kind !== 'lines' ? (
                    <div key={index} className="bg-muted text-muted-foreground px-2">
                      {row.text}
                    </div>
                  ) : (
                    <div key={index} className="grid grid-cols-2">
                      {(['before', 'after'] as const).map(side => {
                        const line = row[side]
                        const number = side === 'before' ? line?.oldNumber : line?.newNumber
                        return (
                          <div
                            key={side}
                            className={cn(
                              'flex min-w-0',
                              side === 'before' && 'border-border border-r',
                              line?.kind === 'addition' && 'bg-success/15',
                              line?.kind === 'deletion' && 'bg-destructive/15',
                            )}
                          >
                            <button
                              type="button"
                              className="text-muted-foreground w-10 shrink-0 px-1 text-right tabular-nums hover:underline"
                              title="Add review comment"
                              disabled={!number || !path}
                              onClick={() =>
                                path &&
                                number &&
                                props.onAddReviewComment(path, number, side === 'before' ? 'LEFT' : 'RIGHT')
                              }
                            >
                              {number ?? ''}
                            </button>
                            <span
                              className={cn(
                                'min-w-0 flex-1 pr-2',
                                wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
                              )}
                            >
                              {line?.text ?? ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  ),
                )}
          </div>
          {((layout === 'unified' && parsed.hunks.some(hunk => hunk.lines.length > maxRows)) ||
            (layout === 'split' && split.length > maxRows)) && (
            <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
              Show all diff lines
            </Button>
          )}
        </div>
      )}
      {diff.data?.truncated && (
        <p className="text-muted-foreground text-xs">
          This patch is incomplete. Open the pull request on GitHub to inspect the remaining changes.
        </p>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={!diff.data?.patch}
        onClick={() => {
          const selection = window.getSelection()?.toString().trim()
          props.onReference(`${path ?? ''}\n\n${selection || diff.data?.patch || ''}`)
        }}
      >
        Add selection or diff to chat
      </Button>
    </section>
  )
}
