import { create } from 'zustand'

/** Palette open state (ADR 0028). Pure UI state — never fetched, never
 * persisted. Toggled by the registry-owned `commandPalette` (`Mod+K`)
 * hotkey; read by the palette dialog. */
export interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const usePaletteStore = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
