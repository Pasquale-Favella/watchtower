import { cn } from '@/shared/lib/utils'

export type SegOption = { value: string; label: string }

/** SegTabs — a segmented control. On our stack this maps to a
 * `Tabs`/`SegmentedControl`-style primitive; hand-rolled here so the prototype
 * is self-contained (a `Tabs` shadcn add could supersede it later). */
export function SegTabs({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<SegOption>
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('border-border bg-background inline-flex gap-px rounded-md border p-0.5', className)}
    >
      {options.map(opt => (
        <span
          key={opt.value}
          role="tab"
          aria-selected={opt.value === value}
          tabIndex={0}
          onClick={() => onChange(opt.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onChange(opt.value)
            }
          }}
          className={cn(
            'cursor-pointer rounded-[5px] px-2.5 py-[3px] text-[11px] whitespace-nowrap',
            opt.value === value
              ? 'bg-card text-foreground font-medium shadow-[inset_0_-2px_0_var(--primary)]'
              : 'text-muted-foreground',
          )}
        >
          {opt.label}
        </span>
      ))}
    </div>
  )
}
