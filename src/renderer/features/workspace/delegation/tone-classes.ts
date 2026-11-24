import type { DelegationTone } from './delegation-status.js'

/** Status dot colours shared by the strip, the details section and the sidebar. */
export const toneDotClass: Readonly<Record<DelegationTone, string>> = {
  active: 'bg-blue-500',
  attention: 'bg-amber-500',
  success: 'bg-emerald-500',
  failure: 'bg-destructive',
  neutral: 'bg-muted-foreground/50',
}

/** Status text colour for the same tones. */
export const toneTextClass: Readonly<Record<DelegationTone, string>> = {
  active: 'text-primary',
  attention: 'text-primary',
  success: 'text-muted-foreground',
  failure: 'text-destructive',
  neutral: 'text-muted-foreground',
}
