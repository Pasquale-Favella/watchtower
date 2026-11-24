/** Divider-style control above the oldest loaded row; older history only loads when the reader asks for it. */
export function TimelineHistoryControl({
  hasMore,
  loading,
  onLoadEarlier,
}: {
  readonly hasMore: boolean
  readonly loading: boolean
  readonly onLoadEarlier: () => void
}): React.JSX.Element | null {
  if (!hasMore && !loading) return null
  return (
    <div className="flex flex-col gap-1.5 pb-2">
      <button
        type="button"
        disabled={loading}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 disabled:hover:text-muted-foreground flex w-full items-center gap-3 rounded-md py-1.5 text-xs transition-colors outline-none focus-visible:ring-3 disabled:cursor-default"
        onClick={onLoadEarlier}
      >
        <span aria-hidden className="bg-border/70 h-px flex-1" />
        <span role={loading ? 'status' : undefined}>{loading ? 'Loading older messages…' : 'Load older messages'}</span>
        <span aria-hidden className="bg-border/70 h-px flex-1" />
      </button>
    </div>
  )
}
