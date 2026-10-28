import { useScanStore } from '@/app/hooks/use-scan-store'

/** The 2px scanning bar — reads `scanning` straight from the scan store
 * (ADR 0011). */
export function ScanIndicator() {
  const { scanning } = useScanStore()
  return (
    <div
      className={`h-[2px] shrink-0 transition-colors ${scanning ? 'bg-primary animate-pulse' : 'bg-transparent'}`}
      role="status"
      aria-label={scanning ? 'Refreshing data in the background' : undefined}
    />
  )
}
