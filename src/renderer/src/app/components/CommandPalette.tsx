import type { ReactElement, ReactNode } from 'react'

import { RefreshCw, PanelLeft } from 'lucide-react'

import {
  Command,
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
import { NAV_SECTIONS, displayShortcutForAction, shortcutForAction, type Section } from '@/app/shortcuts'
import { navigateToSection } from '@/app/navigation'
import { usePaletteStore } from '@/app/stores/palette-store'
import { useScanStore } from '@/app/stores/scan-store'

import { SECTION_ICONS } from '@/app/section-icons'

/** The v1 palette rows (ADR 0028): every Section plus the two runnable
 * registry Actions. The palette's own trigger is never a row. */
export const PALETTE_SECTIONS: readonly Section[] = NAV_SECTIONS
export const PALETTE_ACTIONS = ['refresh', 'toggleSidebar'] as const
export type PaletteAction = (typeof PALETTE_ACTIONS)[number]

/** One palette row: the registry action plus its explicit source (spec §What
 * to build). The Sections/Actions groups below are views over PALETTE_ROWS,
 * so a future `global` source plugs in as data, not structure. */
export type PaletteRow = { action: Section; source: 'section' } | { action: PaletteAction; source: 'action' }

export const PALETTE_ROWS: readonly PaletteRow[] = [
  ...PALETTE_SECTIONS.map((action): PaletteRow => ({ action, source: 'section' })),
  ...PALETTE_ACTIONS.map((action): PaletteRow => ({ action, source: 'action' })),
]

const SECTION_ROWS: readonly PaletteRow[] = PALETTE_ROWS.filter(row => row.source === 'section')
const ACTION_ROWS: readonly PaletteRow[] = PALETTE_ROWS.filter(row => row.source === 'action')

const ACTION_ICONS: Record<PaletteAction, ReactNode> = {
  refresh: <RefreshCw />,
  toggleSidebar: <PanelLeft />,
}

/** Registry label for a row — the single source for display text and filter base. */
export function rowLabel(row: PaletteRow): string {
  return shortcutForAction(row.action)?.label ?? row.action
}

function iconFor(row: PaletteRow): ReactNode {
  return row.source === 'section' ? SECTION_ICONS[row.action] : ACTION_ICONS[row.action]
}

/** cmdk filter key: label plus registry id, so `pullrequests` and
 * `coachskills` match as well as the display labels. */
export function rowFilterValue(row: PaletteRow): string {
  return `${rowLabel(row)} ${row.action}`
}

/** Command palette dialog (ADR 0028) — a pure view over the shortcut registry
 * (ADR 0001): Sections navigate through app/navigation.ts (ADR 0014),
 * refresh reads the scan store, toggleSidebar reads the sidebar context
 * (same source as SidebarToggleShortcut). Mount inside SidebarProvider. */
export function CommandPalette(): ReactElement {
  const open = usePaletteStore(s => s.open)
  const setOpen = usePaletteStore(s => s.setOpen)
  const refresh = useScanStore(s => s.refresh)
  const { toggleSidebar } = useSidebar()

  function runCommand(action: Section | PaletteAction): void {
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

  function renderRow(row: PaletteRow): ReactNode {
    const label = rowLabel(row)
    return (
      <CommandItem key={row.action} value={rowFilterValue(row)} onSelect={() => runCommand(row.action)}>
        {iconFor(row)}
        <span>{label}</span>
        <CommandShortcut>{displayShortcutForAction(row.action)}</CommandShortcut>
      </CommandItem>
    )
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {/* Command owns the cmdk store — every sub-component below reads it
        from context and throws without this ancestor. */}
      <Command>
        <CommandInput placeholder="Go to a section or run an action..." />
        <CommandList>
          <CommandEmpty>No matching section or action.</CommandEmpty>
          <CommandGroup heading="Sections">{SECTION_ROWS.map(renderRow)}</CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">{ACTION_ROWS.map(renderRow)}</CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
