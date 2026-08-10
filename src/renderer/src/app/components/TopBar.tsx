import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { SegTabs } from '@/shared/components/SegTabs'
import { DEFAULT_PERIOD_OPTIONS, PERIOD_LABELS } from '@/shared/lib/settings-constants'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Separator } from '@/shared/components/ui/separator'
import { SidebarTrigger } from '@/shared/components/ui/sidebar'
import { buildScopeCaption, providerOptionsFromDetected } from '@/shared/lib/shell'
import { shortcutForAction } from '@/app/shortcuts'
import { useRouterState } from '@tanstack/react-router'
import { sectionForPath } from '@/app/navigation'
import { useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import { CustomRangePicker } from '@/app/components/CustomRangePicker'
import type { OverviewPeriod } from '../../../../shared/schemas/overview.js'

/** TopBarShell — presentational top bar: title, scope caption, period SegTabs,
 * provider Select, and the custom-range picker slot. Maps the `.pop` (provider
 * picker) and `.dropdown` affordances onto shadcn Select. */
export function TopBarShell({
  title,
  scope,
  period,
  onPeriodChange,
  provider,
  providerLabel,
  providerOptions,
  onProviderSelect,
  children,
}: {
  title: ReactNode
  scope?: ReactNode
  period: string
  onPeriodChange: (value: string) => void
  provider: string
  providerLabel: string
  providerOptions: Array<{ value: string; label: string }>
  onProviderSelect: (value: string) => void
  children?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 pb-[11px] pt-[13px]">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <div className="text-sm font-semibold tracking-tight">{title}</div>
      {scope !== undefined && <span className="text-[11px] text-muted-foreground">{scope}</span>}
      <div className="flex-1" />
      <SegTabs options={DEFAULT_PERIOD_OPTIONS} value={period} onChange={onPeriodChange} />
      <Select value={provider} onValueChange={(value) => { if (value) onProviderSelect(value) }}>
        <SelectTrigger size="sm" className={cn('h-[25px] rounded-md border-border px-2 text-[11px] text-muted-foreground', provider !== 'all' && 'text-foreground')}>
          <SelectValue>{providerLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {providerOptions.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </div>
  )
}

/** TopBar — the store-driven top bar (ADR 0011): reads the section,
 * filters, and detected providers from the shell/scan stores; no more
 * 7-prop package from AppShell. */
export function TopBar() {
  const pathname = useRouterState({ select: s => s.location.pathname })
  const section = sectionForPath(pathname)
  const period = useScopeStore(s => s.period)
  const customRange = useScopeStore(s => s.customRange)
  const provider = useScopeStore(s => s.provider)
  const setPeriod = useScopeStore(s => s.setPeriod)
  const setProvider = useScopeStore(s => s.setProvider)
  const setCustomRange = useScopeStore(s => s.setCustomRange)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  const providerOptions = providerOptionsFromDetected(detectedProviders)
  const providerLabel = providerOptions.find(p => p.value === provider)?.label ?? provider
  const periodLabel = customRange
    ? `${customRange.since} → ${customRange.until}`
    : (PERIOD_LABELS[period] ?? period)
  const scope = buildScopeCaption(periodLabel, providerLabel)

  return (
    <TopBarShell
      title={shortcutForAction(section)?.label ?? section}
      scope={scope}
      period={period}
      onPeriodChange={value => setPeriod(value as OverviewPeriod)}
      provider={provider}
      providerLabel={providerLabel}
      providerOptions={providerOptions}
      onProviderSelect={setProvider}
    >
      <CustomRangePicker
        value={customRange}
        onApply={setCustomRange}
        onClear={() => setCustomRange(null)}
      />
    </TopBarShell>
  )
}
