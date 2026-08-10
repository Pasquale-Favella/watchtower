import type { ComponentProps, ReactNode } from 'react'

import {
  LayoutDashboard, PanelsTopLeft, GitPullRequestArrow, BarChart3, Lightbulb,
  Layers, ArrowLeftRight, Settings,
} from 'lucide-react'
import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'
import { NAV_SECTIONS, shortcutForAction, displayShortcutForAction, type Section } from '@/app/shortcuts'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/shared/components/ui/sidebar'
import { PERIOD_LABELS } from '@/shared/lib/settings-constants'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'

const SECTION_ICONS: Record<Section, ReactNode> = {
  overview: <LayoutDashboard />,
  sessions: <PanelsTopLeft />,
  pullRequests: <GitPullRequestArrow />,
  spend: <BarChart3 />,
  optimize: <Lightbulb />,
  models: <Layers />,
  compare: <ArrowLeftRight />,
  settings: <Settings />,
}

/** Sidebar nav — ids and order come from the shortcuts
 * registry's NAV_SECTIONS; labels and keycap hints come from SHORTCUTS. */
const NAV = NAV_SECTIONS.map(id => ({ id, icon: SECTION_ICONS[id] }))

/** AppSidebarShell — presentational sidebar (shadcn `sidebar-07` pattern):
 * brand header, flat section nav with keyboard-shortcut badges and active-state
 * highlighting, and a scope-caption footer — built entirely on
 * `components/ui/sidebar` and the app's real 8-section navigation model. */
export function AppSidebarShell({
  active,
  onNavigate,
  status,
  ...props
}: {
  active: Section
  onNavigate: (section: Section) => void
  status?: ReactNode
} & ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none hover:bg-transparent group-data-[collapsible=icon]:justify-center">
              {/* Brand: tinted square + wordmark when expanded. In the
               * collapsed 32px icon rail the button itself is size-8 with
               * padding, so the box shrinks to a plain centered icon — the
               * same shape as the nav items beside it. */}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary group-data-[collapsible=icon]:size-4 group-data-[collapsible=icon]:rounded-sm group-data-[collapsible=icon]:bg-transparent">
                {/* Expanded rail: the logo fills most of the 40px brand tile;
                 * collapsed to icon-only, it drops back to the nav-item size.
                 * The `!` important beats the sidebar button's own
                 * `[&_svg]:size-4` descendant rule, which would otherwise pin
                 * every svg inside the button to 16px. */}
                <WatchtowerIcon className="size-6! group-data-[collapsible=icon]:size-6!" />
              </div>
              <span className="truncate text-sm font-bold tracking-tight group-data-[collapsible=icon]:hidden">
                Watchtower
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(item => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={item.id === active}
                    tooltip={shortcutForAction(item.id)?.label ?? item.id}
                    onClick={() => onNavigate(item.id)}
                  >
                    {item.icon}
                    <span>{shortcutForAction(item.id)?.label ?? item.id}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="font-mono text-[10px] font-normal tracking-normal text-muted-foreground">
                    {displayShortcutForAction(item.id)}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {status && (
          <div className="truncate px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
            {status}
          </div>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** AppSidebar — store-driven (ADR 0011): reads the active section, nav,
 * filters, and detected providers from the shell/scan stores. */
export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const active = useShellStore(s => s.section)
  const navigate = useShellStore(s => s.navigate)
  const period = useShellStore(s => s.period)
  const customRange = useShellStore(s => s.customRange)
  const provider = useShellStore(s => s.provider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  const providerOptions = providerOptionsFromDetected(detectedProviders)
  const providerLabel = providerOptions.find(p => p.value === provider)?.label ?? provider
  const periodLabel = customRange
    ? `${customRange.since} → ${customRange.until}`
    : (PERIOD_LABELS[period] ?? period)
  const status = <span>{periodLabel} <b className="font-medium text-foreground">{providerLabel}</b></span>

  return <AppSidebarShell active={active} onNavigate={navigate} status={status} {...props} />
}
