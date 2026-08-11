import { useState } from 'react'

import { Separator } from '@/shared/components/ui/separator'
import { SidebarTrigger } from '@/shared/components/ui/sidebar'
import { GeneralPane } from '@/features/settings/general-pane'
import { ProvidersPane } from '@/features/settings/providers-pane'
import { AliasesPane } from '@/features/settings/aliases-pane'
import { PricingPane } from '@/features/settings/pricing-pane'
import { ExportPane } from '@/features/settings/export-pane'
import { PrivacyPane } from '@/features/settings/privacy-pane'
import { SkillsPane } from '@/features/settings/skills-pane'

type SettingsPane = 'general' | 'providers' | 'aliases' | 'pricing' | 'export' | 'privacy' | 'skills'

const RAIL_ITEMS: Array<{ id: SettingsPane; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'aliases', label: 'Model aliases' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'export', label: 'Export' },
  { id: 'skills', label: 'Skills' },
  { id: 'privacy', label: 'Privacy & data' },
]

/** The Settings section: a six-pane rail — General, Providers,
 * Model aliases, Pricing, Export, Privacy & data — with no Devices pane and
 * no Plans pane (plan/budget editing lives only in the Plans section). Each
 * pane is colocated in its own file under features/settings/. */
export function SettingsView(): React.JSX.Element {
  const [pane, setPane] = useState<SettingsPane>('general')

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-4 pb-[11px] pt-[13px]">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <div className="text-sm font-semibold tracking-tight">Settings</div>
        <div className="flex-1" />
      </div>
      <div className="flex flex-1">
        <nav className="flex w-[198px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3.5" aria-label="Settings sections">
          {RAIL_ITEMS.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={pane === item.id ? 'page' : undefined}
              onClick={() => setPane(item.id)}
              className={`cursor-pointer rounded-md px-2.5 py-[7px] text-left text-[12.5px] hover:bg-accent hover:text-foreground ${pane === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {pane === 'general' && <GeneralPane />}
          {pane === 'providers' && <ProvidersPane />}
          {pane === 'aliases' && <AliasesPane />}
          {pane === 'pricing' && <PricingPane />}          { pane === 'export' && <ExportPane /> }
          { pane === 'skills' && <SkillsPane /> }
          { pane === 'privacy' && <PrivacyPane /> }
        </div>
      </div>
    </div>
  )
}
