import { useScanStore } from '@/app/stores/scan-store'

/** The 2px scanning bar — reads `scanning` straight from the scan store
 * (ADR 0011). */
export function ScanIndicator() {
  const scanning = useScanStore(s => s.scanning)
  return (
    <div
      className={`h-[2px] shrink-0 transition-colors ${scanning ? 'bg-primary animate-pulse' : 'bg-transparent'}`}
      role="status"
      aria-label={scanning ? 'Refreshing data in the background' : undefined}
    />
  )
}
