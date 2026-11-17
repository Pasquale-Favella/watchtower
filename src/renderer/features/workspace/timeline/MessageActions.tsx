import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
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
      <time dateTime={timestamp} title={timestamp}>
        {formatMessageTime(timestamp)}
      </time>
      {copyText !== null && <CopyTextButton text={copyText} label={copyLabel} />}
      {children}
    </div>
  )
}

export function CopyTextButton({ text, label }: { readonly text: string; readonly label: string }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const id = window.setTimeout(() => {
      setStatus('idle')
    }, COPIED_FEEDBACK_MS)
    return () => {
      window.clearTimeout(id)
    }
  }, [status])
  const copied = status === 'copied'
  const copy = async () => {
    if (!navigator.clipboard) {
      setStatus('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? `${label} copied` : label}
      title={status === 'failed' ? 'Could not copy to clipboard' : label}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {status === 'failed' && (
        <span role="status" className="sr-only">
          Could not copy to clipboard
        </span>
      )}
    </Button>
  )
}
