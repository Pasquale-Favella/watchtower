import { WrapTextIcon } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'

import { CopyTextButton } from './MessageActions.js'
import { terminalOutputSpans } from './terminal-output.js'
import { formatToolValue } from './tool-presentation.js'

export function ToolOutputPanel({
  text,
  label,
  terminal = false,
  running = false,
  error = false,
}: {
  readonly text: string
  readonly label: string
  readonly terminal?: boolean
  readonly running?: boolean
  readonly error?: boolean
}): React.JSX.Element {
  const [wrapped, setWrapped] = useState(false)
  const viewport = useRef<HTMLPreElement | null>(null)
  const following = useRef(true)
  const formatted = useMemo(() => (terminal ? text : formatToolValue(text)), [terminal, text])
  const spans = useMemo(() => terminalOutputSpans(formatted), [formatted])
  const copyText = useMemo(() => spans.map(span => span.text).join(''), [spans])

  useLayoutEffect(() => {
    if (running && following.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }, [formatted, running, wrapped])

  return (
    <section className="overflow-hidden rounded-md border" aria-label={label}>
      <div className="bg-muted/40 flex min-h-8 items-center gap-2 border-b px-2.5">
        <h4 className={cn('mr-auto text-[11px] font-medium', error && 'text-destructive')}>{label}</h4>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Wrap ${label.toLowerCase()}`}
          title="Toggle line wrapping"
          aria-pressed={wrapped}
          onClick={() => setWrapped(current => !current)}
        >
          <WrapTextIcon aria-hidden />
        </Button>
        <CopyTextButton text={copyText} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre
        ref={viewport}
        className={cn(
          'bg-background/60 m-0 max-h-80 overflow-auto p-2.5 font-mono text-xs leading-relaxed',
          wrapped ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          error && 'text-destructive',
        )}
        onScroll={event => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8
        }}
        tabIndex={0}
      >
        {spans.map((span, index) => (
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ))}
      </pre>
    </section>
  )
}
