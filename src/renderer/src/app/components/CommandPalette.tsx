import type { ReactNode } from 'react'

import {
  LayoutDashboard, PanelsTopLeft, GitPullRequestArrow, BarChart3, Lightbulb,
  Layers, ArrowLeftRight, Sparkles, Settings, RefreshCw, PanelLeft,
} from 'lucide-react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/shared/components/ui/command'
import { useSidebar } from '@/shared/components/ui/sidebar'
import {
  NAV_SECTIONS,
  displayShortcutForAction,
  shortcutForAction,
  type Section,
} from '@/app/shortcuts'
import { navigateToSection } from '@/app/navigation'
import { usePaletteStore } from '@/app/stores/palette-store'
import { useScanStore } from '@/app/stores/scan-store'

/** Section icons — mirrors `SECTION_ICONS` in app-sidebar (kept local so this
 * module never imports the sidebar's router-bound tree). */
const SECTION_ICONS: Record<Section, ReactNode> = {
  overview: <LayoutDashboard />,
  sessions: <PanelsTopLeft />,
  pullRequests: <GitPullRequestArrow />,
  spend: <BarChart3 />,
  optimize: <Lightbulb />,
  models: <Layers />,
  compare: <ArrowLeftRight />,
  coachSkills: <Sparkles />,
  settings: <Settings />,
}

/** The v1 palette rows (ADR 0028): every Section plus the two runnable
 * registry Actions. The palette's own trigger is never a row. */
export const PALETTE_SECTIONS: readonly Section[] = NAV_SECTIONS
export const PALETTE_ACTIONS = ['refresh', 'toggleSidebar'] as const
export type PaletteAction = (typeof PALETTE_ACTIONS)[number]

const ACTION_ICONS: Record<PaletteAction, ReactNode> = {
  refresh: <RefreshCw />,
  toggleSidebar: <PanelLeft />,
}

/** Command palette dialog (ADR 0028) — a pure view over the shortcut registry
 * (ADR 0001): Sections navigate through app/navigation.ts (ADR 0014),
 * refresh reads the scan store, toggleSidebar reads the sidebar context
 * (same source as SidebarToggleShortcut). Mount inside SidebarProvider.
 * Rows carry an implicit `section | action` source split via the two groups,
 * reserved for a future global-search source. */
export function CommandPalette() {
  const open = usePaletteStore(s => s.open)
  const setOpen = usePaletteStore(s => s.setOpen)
  const refresh = useScanStore(s => s.refresh)
  const { toggleSidebar } = useSidebar()

  const run = (action: Section | PaletteAction): void => {
    setOpen(false)
    if (action === 'refresh') {
      void refresh()
      return
    }
    if (action === 'toggleSidebar') {
      toggleSidebar()
      return
    }
    navigateToSection(action)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Go to a section or run an action..." />
      <CommandList>
        <CommandEmpty>No matching section or action.</CommandEmpty>
        <CommandGroup heading="Sections">
          {PALETTE_SECTIONS.map(section => (
            <CommandItem
              key={section}
              value={shortcutForAction(section)?.label ?? section}
              onSelect={() => run(section)}
            >
              {SECTION_ICONS[section]}
              <span>{shortcutForAction(section)?.label ?? section}</span>
              <CommandShortcut>{displayShortcutForAction(section)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {PALETTE_ACTIONS.map(action => (
            <CommandItem
              key={action}
              value={shortcutForAction(action)?.label ?? action}
              onSelect={() => run(action)}
            >
              {ACTION_ICONS[action]}
              <span>{shortcutForAction(action)?.label ?? action}</span>
              <CommandShortcut>{displayShortcutForAction(action)}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
