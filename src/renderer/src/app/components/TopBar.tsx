import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { scanStateAtom } from '@/app/atoms/scan'
import {
  customRangeAtom,
  periodAtom,
  providerAtom,
  setCustomRangeAtom,
  setPeriodAtom,
  setProviderAtom,
} from '@/app/atoms/scope'
import { CustomRangePicker } from '@/app/components/CustomRangePicker'
import { sectionForPath } from '@/app/navigation'
import { shortcutForAction } from '@/app/shortcuts'
import { SegTabs } from '@/shared/components/SegTabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { Separator } from '@/shared/components/ui/separator'
import { SidebarTrigger } from '@/shared/components/ui/sidebar'
import { DEFAULT_PERIOD_OPTIONS, PERIOD_LABELS } from '@/shared/lib/settings-constants'
import { buildScopeCaption, providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

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
    <div className="border-border flex items-center gap-2.5 border-b px-4 pt-[13px] pb-[11px]">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <div className="text-sm font-semibold tracking-tight">{title}</div>
      {scope !== undefined && <span className="text-muted-foreground text-[11px]">{scope}</span>}
      <div className="flex-1" />
      <SegTabs options={DEFAULT_PERIOD_OPTIONS} value={period} onChange={onPeriodChange} />
      <Select
        value={provider}
        onValueChange={value => {
          if (value) onProviderSelect(value)
        }}
      >
        <SelectTrigger
          size="sm"
          className={cn(
            'border-border text-muted-foreground h-[25px] rounded-md px-2 text-[11px]',
            provider !== 'all' && 'text-foreground',
          )}
        >
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
 * 7-prop package from AppRoot. */
export function TopBar() {
  const pathname = useRouterState({ select: s => s.location.pathname })
  const section = sectionForPath(pathname)
  const period = useAtomValue(periodAtom)
  const customRange = useAtomValue(customRangeAtom)
  const provider = useAtomValue(providerAtom)
  const setPeriod = useAtomSet(setPeriodAtom)
  const setProvider = useAtomSet(setProviderAtom)
  const setCustomRange = useAtomSet(setCustomRangeAtom)
  const detectedProviders = useAtomValue(scanStateAtom).detectedProviders

  const providerOptions = providerOptionsFromDetected(detectedProviders)
  const providerLabel = providerOptions.find(p => p.value === provider)?.label ?? provider
  const periodLabel = customRange ? `${customRange.since} → ${customRange.until}` : (PERIOD_LABELS[period] ?? period)
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
      <CustomRangePicker value={customRange} onApply={setCustomRange} onClear={() => setCustomRange(null)} />
    </TopBarShell>
  )
}
