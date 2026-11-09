import { useRouterState } from '@tanstack/react-router'
import { ChartNoAxesCombined, Check, ChevronsUpDown, PanelsTopLeft } from 'lucide-react'
import type { ComponentProps } from 'react'

import { type AppVertical, navigateToSection, sectionForPath } from '@/renderer/app/navigation'
import { SECTION_ICONS } from '@/renderer/app/section-icons'
import { displayShortcutForAction, NAV_SECTIONS, shortcutForAction } from '@/renderer/app/shortcuts'
import { WatchtowerIcon } from '@/renderer/components/shell/WatchtowerIcon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
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
  useSidebar,
} from '@/renderer/components/ui/sidebar'
import { WorkspaceSidebar } from '@/renderer/features/workspace/WorkspaceSidebar'
import { PERIOD_LABELS } from '@/renderer/shared/lib/settings-constants'
import { providerOptionsFromDetected } from '@/renderer/shared/lib/shell'
import { useAppVerticalStore } from '@/renderer/stores/hooks/use-app-vertical-store'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'

const VERTICALS = [
  { id: 'analytics', label: 'Analytics', icon: ChartNoAxesCombined },
  { id: 'workspace', label: 'Workspace', icon: PanelsTopLeft },
] as const satisfies readonly { id: AppVertical; label: string; icon: typeof ChartNoAxesCombined }[]

/** The sidebar-07 team switcher selects the application's active vertical. */
function VerticalSwitcher() {
  const { vertical, switchVertical } = useAppVerticalStore()
  const { isMobile } = useSidebar()
  const active = vertical === 'analytics' ? VERTICALS[0] : VERTICALS[1]

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Switch application, ${active.label}`}
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
              />
            }
          >
            <div className="bg-primary/10 text-primary flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg">
              <WatchtowerIcon className="size-5!" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-semibold">Watchtower</span>
              <span className="text-muted-foreground truncate text-xs">{active.label}</span>
            </div>
            <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]:hidden" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-52" align="start" side={isMobile ? 'bottom' : 'right'}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Application</DropdownMenuLabel>
              {VERTICALS.map(item => (
                <DropdownMenuItem key={item.id} onClick={() => switchVertical(item.id)} className="gap-2 p-2">
                  <item.icon />
                  {item.label}
                  {item.id === vertical && <Check className="ml-auto" aria-label="Selected" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function AnalyticsNavigation() {
  const pathname = useRouterState({ select: state => state.location.pathname })
  const active = sectionForPath(pathname)
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV_SECTIONS.map(section => (
            <SidebarMenuItem key={section}>
              <SidebarMenuButton
                isActive={section === active}
                tooltip={shortcutForAction(section)?.label ?? section}
                onClick={() => {
                  navigateToSection(section)
                  if (isMobile) setOpenMobile(false)
                }}
              >
                {SECTION_ICONS[section]}
                <span>{shortcutForAction(section)?.label ?? section}</span>
              </SidebarMenuButton>
              <SidebarMenuBadge className="text-muted-foreground font-mono text-[10px] font-normal tracking-normal">
                {displayShortcutForAction(section)}
              </SidebarMenuBadge>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function AnalyticsScopeCaption() {
  const { period, customRange, provider, detectedProviders } = useScopeStore()
  const providerLabel =
    providerOptionsFromDetected(detectedProviders).find(item => item.value === provider)?.label ?? provider
  const periodLabel = customRange ? `${customRange.since} → ${customRange.until}` : (PERIOD_LABELS[period] ?? period)

  return (
    <div className="text-muted-foreground truncate px-2 py-1 font-mono text-[11px] tabular-nums group-data-[collapsible=icon]:hidden">
      {periodLabel} <b className="text-foreground font-medium">{providerLabel}</b>
    </div>
  )
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const { vertical } = useAppVerticalStore()

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <VerticalSwitcher />
      </SidebarHeader>
      <SidebarContent>{vertical === 'workspace' ? <WorkspaceSidebar /> : <AnalyticsNavigation />}</SidebarContent>
      {vertical === 'analytics' && (
        <SidebarFooter>
          <AnalyticsScopeCaption />
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  )
}
