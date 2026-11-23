import { ChartNoAxesCombined, PanelsTopLeft, Settings } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/renderer/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/renderer/components/ui/sidebar'

import { AliasesPane } from './aliases-pane'
import { AnalyticsPane } from './analytics-pane'
import { SETTINGS_GROUP_LABELS, SETTINGS_GROUPS, SETTINGS_PANES, type SettingsPane } from './dialog-navigation'
import { ExportPane } from './export-pane'
import { GeneralPane } from './general-pane'
import { McpPane } from './mcp-pane'
import { PricingPane } from './pricing-pane'
import { PrivacyPane } from './privacy-pane'
import { ProvidersPane } from './providers-pane'
import { SkillsPane } from './skills-pane'
import { SourceControlPane } from './source-control-pane'
import { useSettingsDialogStore } from './use-settings-dialog-store'
import { WorkspacePane } from './workspace-pane'

const GROUP_ICONS = { general: Settings, analytics: ChartNoAxesCombined, workspace: PanelsTopLeft }

function SettingsPaneContent({ pane }: { readonly pane: SettingsPane }): React.JSX.Element {
  switch (pane) {
    case 'general':
      return <GeneralPane />
    case 'analytics':
      return <AnalyticsPane />
    case 'providers':
      return <ProvidersPane />
    case 'aliases':
      return <AliasesPane />
    case 'pricing':
      return <PricingPane />
    case 'export':
      return <ExportPane />
    case 'privacy':
      return <PrivacyPane />
    case 'skills':
      return <SkillsPane />
    case 'mcp':
      return <McpPane />
    case 'workspace':
      return <WorkspacePane />
    case 'source-control':
      return <SourceControlPane />
  }
}

/** Shared settings, using sidebar-13's non-collapsible sidebar inside a dialog. */
export function SettingsDialog(): React.JSX.Element {
  const { open, setOpen, group, pane, selectGroup, selectPane } = useSettingsDialogStore()
  const items = SETTINGS_PANES[group]
  const title = items.find(item => item.id === pane)?.label ?? ''

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-3 pr-12">
          <Settings className="text-muted-foreground size-4" />
          <DialogTitle className="text-sm font-semibold">Settings</DialogTitle>
          <DialogDescription className="sr-only">Manage General, Analytics, and Workspace settings.</DialogDescription>
        </div>
        <SidebarProvider
          className="min-h-0 flex-1 items-stretch"
          style={{ '--sidebar-width': '180px' } as React.CSSProperties}
        >
          <Sidebar collapsible="none" className="border-border w-[140px] shrink-0 border-r sm:w-[180px]">
            <SidebarContent>
              <nav aria-label="Settings groups">
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {SETTINGS_GROUPS.map(id => {
                        const Icon = GROUP_ICONS[id]
                        return (
                          <SidebarMenuItem key={id}>
                            <SidebarMenuButton
                              isActive={group === id}
                              aria-pressed={group === id}
                              onClick={() => selectGroup(id)}
                            >
                              <Icon />
                              <span>{SETTINGS_GROUP_LABELS[id]}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </nav>
              <nav aria-label={`${SETTINGS_GROUP_LABELS[group]} settings`} className="border-border mx-2 border-t pt-2">
                <SidebarMenu>
                  {items.map(item => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        className="h-auto min-h-8 text-xs"
                        isActive={pane === item.id}
                        aria-current={pane === item.id ? 'page' : undefined}
                        onClick={() => selectPane(item.id)}
                      >
                        <span className="whitespace-normal">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarContent>
          </Sidebar>
          <section className="flex min-w-0 flex-1 flex-col" aria-label={title}>
            <div className="text-muted-foreground shrink-0 border-b px-5 py-3 text-xs">
              {SETTINGS_GROUP_LABELS[group]}{' '}
              <span aria-hidden="true" className="px-1">
                /
              </span>{' '}
              <span className="text-foreground">{title}</span>
            </div>
            <div key={pane} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <SettingsPaneContent pane={pane} />
            </div>
          </section>
        </SidebarProvider>
        <div className="border-border flex shrink-0 justify-end border-t px-4 py-2">
          <DialogClose render={<Button variant="outline" size="sm" />}>Done</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
