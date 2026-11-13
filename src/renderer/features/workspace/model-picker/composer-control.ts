import { cn } from '@/renderer/shared/lib/utils'

/** Borderless composer footer control, shared by the model trigger and the permissions chip. */
export function composerControlClass(className?: string): string {
  return cn(
    'text-foreground/80 hover:bg-accent hover:text-foreground focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    className,
  )
}
