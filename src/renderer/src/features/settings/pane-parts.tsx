import { useState } from 'react'

import { Button } from '@/shared/components/ui/button'

/** The small title + subtitle header every settings pane leads with. */
export function PaneHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <p className="text-[13px] font-semibold tracking-tight">{title}</p>
      <p className="text-muted-foreground mt-0.5 text-[11px]">{subtitle}</p>
    </div>
  )
}

/** Inline destructive confirm: the button swaps to a prompt + Confirm/Cancel
 * in place (no OS dialog). Auto-cancels on Escape or when focus leaves. */
export function ConfirmRemove({ label, prompt, onConfirm }: { label: string; prompt: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="xs" onClick={() => setConfirming(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span
      className="flex items-center gap-1.5"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirming(false)
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') setConfirming(false)
      }}
    >
      <span className="text-muted-foreground text-[11px]">{prompt}</span>
      <Button
        type="button"
        variant="destructive"
        size="xs"
        autoFocus
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
      >
        Confirm
      </Button>
      <Button type="button" variant="outline" size="xs" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  )
}
