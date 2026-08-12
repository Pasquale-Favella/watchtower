import { useEffect, useState } from 'react'

import { Check, ChevronRight, CircleAlert, Copy, FileText, Globe, Loader2, RotateCcw, Search, Terminal, Wrench } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { Markdown } from '@/shared/components/Markdown'
import type { ToolNotice } from './store'

/** The live streaming indicator: three staggered dots + an optional label
 *  ("Thinking…", "Working…"), an elements.ai-sdk.dev touch for the running
 *  state of a turn. Pure CSS animation — no GSAP, so it also runs in tests. */
export function StreamingDots({ label = 'Working', className }: { label?: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] text-muted-foreground', className)}>
      <span className="flex items-center gap-0.5" aria-hidden>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="size-1 rounded-full bg-current opacity-60 animate-pulse"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      <span className="sr-only">streaming</span>
      {label}
    </span>
  )
}

/** Copy the assistant answer to the clipboard with a brief "Copied" state.
 *  Hover-reveal on the message row (opacity transition), keyboard-focusable. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={!text}
      aria-label={copied ? 'Copied' : 'Copy answer'}
      title={copied ? 'Copied' : 'Copy answer'}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0',
        copied && 'text-success opacity-100',
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

/** Regenerate the last assistant answer — the message-level retry action,
 *  shown next to Copy. Hover-reveal on the message row, keyboard-focusable;
 *  disabled while a run is in flight or the turn is still streaming. */
export function RetryButton({ onRetry, disabled = false, className }: {
  onRetry: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={disabled}
      aria-label="Regenerate answer"
      title="Regenerate answer"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0',
        className,
      )}
    >
      <RotateCcw className="size-3" />
    </button>
  )
}

/** Elapsed time as a compact `12s` / `1m 05s` label for the reasoning panel. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/** The live elapsed label for the Thinking header — OWNS its own interval and
 *  state so each 250ms tick re-renders ONLY this tiny span, never the
 *  ThinkingBlock body (whose streaming markdown must not be re-parsed 4×/s).
 *  While streaming it ticks; once the turn finishes it freezes on the final
 *  duration; a block that mounts already-completed (e.g. a restored turn)
 *  shows nothing. */
function ElapsedLabel({ streaming, dim }: { streaming: boolean; dim?: boolean }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!streaming) return
    const started = Date.now()
    setElapsed(0)
    const id = window.setInterval(() => setElapsed(Date.now() - started), 250)
    return () => window.clearInterval(id)
  }, [streaming])

  if (!streaming && elapsed === 0) return null
  return (
    <span className={cn('tabular-nums text-[9.5px]', dim ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
      {formatElapsed(elapsed)}
    </span>
  )
}

/** The thinking/reasoning panel — an elements.ai-sdk.dev Reasoning-style
 *  collapsible that STARTS COLLAPSED: the header (pulsing dot, "Thinking",
 *  live elapsed timer) keeps the run visible without the content spilling into
 *  the thread, and the user clicks to read the thinking. `defaultOpen` is the
 *  escape hatch for static showcases (the welcome demo). The body renders the
 *  accumulated thinking as streaming markdown (code, emphasis, lists) with
 *  hard line breaks preserved, plus a blinking caret at the stream tail. */
export function ThinkingBlock({ thinking, streaming, defaultOpen = false }: {
  thinking: string
  streaming: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2 overflow-hidden rounded-lg border border-border/80 bg-muted/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60">
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-data-open:rotate-90',
            open && 'rotate-90',
          )}
        />
        <span className="relative flex size-2 shrink-0 items-center justify-center">
          {streaming ? (
            <span className="absolute size-2 animate-ping rounded-full bg-primary/40" />
          ) : null}
          <span
            className={cn(
              'size-2 rounded-full',
              streaming ? 'bg-primary' : 'bg-muted-foreground/50',
            )}
          />
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Thinking
        </span>
        <ElapsedLabel streaming={streaming} dim={!streaming} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="typeset typeset-chat max-h-[220px] overflow-y-auto px-3 pb-2.5 text-[11px] leading-relaxed text-muted-foreground [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap">
          <Markdown>{thinking}</Markdown>
          {streaming && <span className="animate-pulse text-primary">▍</span>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A small per-icon mapping so common agent tools read at a glance (Bash,
 *  Read/Edit, Search/Glob, ledger queries, …). Unknown tools get the wrench
 *  fallback. */
function ToolGlyph({ tool }: { tool: string }) {
  const t = tool.toLowerCase()
  if (t.includes('bash') || t.includes('sh') || t.includes('shell') || t.includes('command') || t.includes('exec')) return <Terminal className="size-3.5" />
  if (t.includes('read') || t.includes('write') || t.includes('edit') || t.includes('view') || t.includes('patch')) return <FileText className="size-3.5" />
  if (t.includes('glob') || t.includes('grep') || t.includes('search') || t.includes('find')) return <Search className="size-3.5" />
  if (t.includes('ledger') || t.includes('web') || t.includes('fetch') || t.includes('http')) return <Globe className="size-3.5" />
  return <Wrench className="size-3.5" />
}

/** A status badge for one tool call — Running (spinner), Done (check), or
 *  Error — the elements.ai-sdk.dev ToolHeader status treatment. */
function ToolStatus({ notice, streaming }: { notice: ToolNotice; streaming: boolean }) {
  const running = notice.state === 'started' && streaming
  if (running) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
        <Loader2 className="size-2.5 animate-spin" />
        Running
      </span>
    )
  }
  if (notice.state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive">
        <CircleAlert className="size-2.5" />
        Error
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-medium text-success">
      <Check className="size-2.5" />
      Done
    </span>
  )
}

/** One tool call on the running turn — an elements.ai-sdk.dev Tool-style card
 *  that STARTS COLLAPSED: the header (icon, tool name, lifecycle status
 *  badge) keeps the run readable, and the user clicks to inspect the
 *  input/output/error previews. `defaultOpen` is the escape hatch for static
 *  showcases (the welcome demo). */
export function ToolCard({ notice, streaming, defaultOpen = false }: {
  notice: ToolNotice
  streaming: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border border-border/80 bg-card/60">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40">
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-muted-foreground">
          <ToolGlyph tool={notice.tool} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">{notice.tool}</span>
        {notice.title && <span className="hidden max-w-[40%] truncate text-[10px] text-muted-foreground sm:inline">{notice.title}</span>}
        <ToolStatus notice={notice} streaming={streaming} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        {(notice.input || notice.output || notice.error) && (
          <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
            {notice.input && (
              <div>
                <p className="mb-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Input</p>
                <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/70 p-2 font-mono text-[9.5px] leading-relaxed text-muted-foreground">{notice.input}</pre>
              </div>
            )}
            {notice.output && (
              <div>
                <p className="mb-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Output</p>
                <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/70 p-2 font-mono text-[9.5px] leading-relaxed text-muted-foreground">{notice.output}</pre>
              </div>
            )}
            {notice.error && (
              <div>
                <p className="mb-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-destructive/80">Error</p>
                <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-2 font-mono text-[9.5px] leading-relaxed text-destructive">{notice.error}</pre>
              </div>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
