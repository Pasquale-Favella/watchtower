import type { ReactNode } from 'react'

export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd
      data-slot="kbd"
      className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded px-1 font-sans text-[0.6875rem] font-medium [&_svg]:size-3"
    >
      {children}
    </kbd>
  )
}
