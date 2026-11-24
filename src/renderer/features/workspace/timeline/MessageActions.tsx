import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'

import { formatMessageTime } from './message-time.js'

const COPIED_FEEDBACK_MS = 1500

/** Hover or focus reveals the row; it stays out of the reading flow until the reader asks for it. */
export function MessageActions({
  copyText,
  copyLabel,
  timestamp,
  children,
  className,
}: {
  /** Null hides the copy action, for example while a response is still streaming. */
  readonly copyText: string | null
  readonly copyLabel: string
  readonly timestamp: string
  readonly children?: React.ReactNode
  readonly className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-2 text-xs opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100',
        className,
      )}
    >
      <TextTooltip label={timestamp} trigger={<time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>} />
      {copyText !== null && <CopyTextButton text={copyText} label={copyLabel} />}
      {children}
    </div>
  )
}

/**
 * A function text is read when the button is pressed, for text that is not at hand yet. While it loads the button is
 * busy, and a failed read reports why instead of copying something else.
 */
export function CopyTextButton({
  text,
  label,
}: {
  readonly text: string | (() => Promise<string>)
  readonly label: string
}): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const [failure, setFailure] = useState('Could not copy to clipboard')
  useEffect(() => {
    if (status === 'idle' || status === 'copying') return
    const id = window.setTimeout(() => {
      setStatus('idle')
    }, COPIED_FEEDBACK_MS)
    return () => {
      window.clearTimeout(id)
    }
  }, [status])
  const copied = status === 'copied'
  const copy = async () => {
    if (status === 'copying') return
    if (!navigator.clipboard) {
      setFailure('Could not copy to clipboard')
      setStatus('failed')
      return
    }
    let value: string
    if (typeof text === 'string') value = text
    else {
      setStatus('copying')
      try {
        value = await text()
      } catch (cause) {
        setFailure(
          cause instanceof Error && cause.message
            ? `Could not copy: ${cause.message}`
            : 'Could not load the text to copy',
        )
        setStatus('failed')
        return
      }
    }
    try {
      await navigator.clipboard.writeText(value)
      setStatus('copied')
    } catch {
      setFailure('Could not copy to clipboard')
      setStatus('failed')
    }
  }
  return (
    <TextTooltip
      label={status === 'failed' ? failure : status === 'copying' ? `${label}, loading` : label}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? `${label} copied` : label}
          aria-busy={status === 'copying'}
          disabled={status === 'copying'}
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {status === 'failed' && (
            <span role="status" className="sr-only">
              {failure}
            </span>
          )}
        </Button>
      }
    />
  )
}
