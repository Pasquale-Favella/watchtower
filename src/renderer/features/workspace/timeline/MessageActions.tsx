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
      <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>
      {copyText !== null && <CopyMessageButton text={copyText} label={copyLabel} />}
      {children}
    </div>
  )
}

function CopyMessageButton({ text, label }: { readonly text: string; readonly label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => {
      setCopied(false)
    }, COPIED_FEEDBACK_MS)
    return () => {
      window.clearTimeout(id)
    }
  }, [copied])
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? `${label} copied` : label}
      title={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
          })
          .catch(() => undefined)
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </Button>
  )
}
