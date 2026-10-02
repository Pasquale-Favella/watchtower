import { useEffect, useState } from 'react'

import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  Globe,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/components/ui/collapsible'
import { Markdown } from '@/shared/components/Markdown'
import type { ToolNotice } from './store'

/** Phase offsets for the streaming-dot wave: each dot starts its bounce a
 *  beat later, so the three read as a left-to-right ripple. Kept as static
 *  strings so Tailwind emits the delay utilities. */
const STREAMING_DOT_DELAYS = ['delay-0', 'delay-150', 'delay-300'] as const

/** Live running indicator for a turn: three dots rippling in sequence next
 *  to a "Thinking"/"Working" label. */
export function StreamingDots({ label = 'Working', className }: { label?: string; className?: string }) {
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1 text-[10px]', className)}>
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map(i => (
          <span key={i} className={cn('size-1 animate-bounce rounded-full bg-current', STREAMING_DOT_DELAYS[i])} />
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
        'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 transition-[opacity,background-color,color] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-0',
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
export function RetryButton({
  onRetry,
  disabled = false,
  className,
}: {
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
        'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 transition-[opacity,background-color,color] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-0',
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
    <span className={cn('text-[9.5px] tabular-nums', dim ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
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
export function ThinkingBlock({
  thinking,
  streaming,
  defaultOpen = false,
}: {
  thinking: string
  streaming: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border/80 bg-muted/40 mt-3 overflow-hidden rounded-xl border"
    >
      <CollapsibleTrigger className="group hover:bg-muted/60 flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors">
        <ChevronRight
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-200 group-data-open:rotate-90',
            open && 'rotate-90',
          )}
        />
        <span className="relative flex size-2 shrink-0 items-center justify-center">
          {streaming ? <span className="bg-primary/40 absolute size-2 animate-ping rounded-full" /> : null}
          <span className={cn('size-2 rounded-full', streaming ? 'bg-primary' : 'bg-muted-foreground/50')} />
        </span>
        <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">Thinking</span>
        <ElapsedLabel streaming={streaming} dim={!streaming} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="typeset typeset-chat text-muted-foreground max-h-[220px] overflow-y-auto px-4 pb-3 text-[13px] leading-relaxed [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap">
          <Markdown>{thinking}</Markdown>
          {streaming && <span className="text-primary animate-pulse">▍</span>}
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
  if (t.includes('bash') || t.includes('sh') || t.includes('shell') || t.includes('command') || t.includes('exec'))
    return <Terminal className="size-3.5" />
  if (t.includes('read') || t.includes('write') || t.includes('edit') || t.includes('view') || t.includes('patch'))
    return <FileText className="size-3.5" />
  if (t.includes('glob') || t.includes('grep') || t.includes('search') || t.includes('find'))
    return <Search className="size-3.5" />
  if (t.includes('ledger') || t.includes('web') || t.includes('fetch') || t.includes('http'))
    return <Globe className="size-3.5" />
  return <Wrench className="size-3.5" />
}

/** A status badge for one tool call — Running (spinner), Done (check), or
 *  Error — the elements.ai-sdk.dev ToolHeader status treatment. */
function ToolStatus({ notice, streaming }: { notice: ToolNotice; streaming: boolean }) {
  const running = notice.state === 'started' && streaming
  if (running) {
    return (
      <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
        <Loader2 className="size-2.5 animate-spin" />
        Running
      </span>
    )
  }
  if (notice.state === 'error') {
    return (
      <span className="bg-destructive/10 text-destructive inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
        <CircleAlert className="size-2.5" />
        Error
      </span>
    )
  }
  return (
    <span className="bg-success/10 text-success inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
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
export function ToolCard({
  notice,
  streaming,
  defaultOpen = false,
}: {
  notice: ToolNotice
  streaming: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border/80 bg-card/60 overflow-hidden rounded-xl border"
    >
      <CollapsibleTrigger className="group hover:bg-muted/40 flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors">
        <ChevronRight
          className={cn('text-muted-foreground size-3 shrink-0 transition-transform duration-200', open && 'rotate-90')}
        />
        <span className="text-muted-foreground shrink-0">
          <ToolGlyph tool={notice.tool} />
        </span>
        <span className="text-foreground min-w-0 flex-1 truncate font-mono text-[10.5px]">{notice.tool}</span>
        {notice.title && (
          <span className="text-muted-foreground hidden max-w-[40%] truncate text-[10px] sm:inline">
            {notice.title}
          </span>
        )}
        <ToolStatus notice={notice} streaming={streaming} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        {(notice.input || notice.output || notice.error) && (
          <div className="border-border/60 space-y-1.5 border-t px-2.5 py-2">
            {notice.input && (
              <div>
                <p className="text-muted-foreground/70 mb-0.5 text-[8.5px] font-semibold tracking-wide uppercase">
                  Input
                </p>
                <pre className="bg-muted/70 text-muted-foreground max-h-[160px] overflow-auto rounded-md p-2 font-mono text-[9.5px] leading-relaxed whitespace-pre-wrap">
                  {notice.input}
                </pre>
              </div>
            )}
            {notice.output && (
              <div>
                <p className="text-muted-foreground/70 mb-0.5 text-[8.5px] font-semibold tracking-wide uppercase">
                  Output
                </p>
                <pre className="bg-muted/70 text-muted-foreground max-h-[160px] overflow-auto rounded-md p-2 font-mono text-[9.5px] leading-relaxed whitespace-pre-wrap">
                  {notice.output}
                </pre>
              </div>
            )}
            {notice.error && (
              <div>
                <p className="text-destructive/80 mb-0.5 text-[8.5px] font-semibold tracking-wide uppercase">Error</p>
                <pre className="bg-destructive/10 text-destructive max-h-[160px] overflow-auto rounded-md p-2 font-mono text-[9.5px] leading-relaxed whitespace-pre-wrap">
                  {notice.error}
                </pre>
              </div>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
