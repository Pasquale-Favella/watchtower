import { Counter } from './Counter'

/** One quiet line under the status: how many sources and files so far. */
export function Tally({ sources, files }: { sources: number; files: number }) {
  return (
    <div data-splash="fade" className="text-muted-foreground mt-3 h-4 text-[11px] tabular-nums">
      {sources > 0 && (
        <>
          <Counter value={sources} className="text-foreground font-medium" /> {sources === 1 ? 'source' : 'sources'}
          <span className="mx-1.5 opacity-50">·</span>
          <Counter value={files} className="text-foreground font-medium" /> session files read
        </>
      )}
    </div>
  )
}
