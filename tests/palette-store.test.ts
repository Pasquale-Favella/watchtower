import { beforeEach, describe, expect, it } from 'vitest'

import { usePaletteStore } from '../src/renderer/src/app/stores/palette-store.js'

beforeEach(() => {
  usePaletteStore.setState(usePaletteStore.getInitialState(), true)
})

describe('usePaletteStore (ADR 0028)', () => {
  it('starts closed', () => {
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it('setOpen opens and closes explicitly', () => {
    usePaletteStore.getState().setOpen(true)
    expect(usePaletteStore.getState().open).toBe(true)
    usePaletteStore.getState().setOpen(false)
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it('toggle flips from either state (Mod+K route)', () => {
    usePaletteStore.getState().toggle()
    expect(usePaletteStore.getState().open).toBe(true)
    usePaletteStore.getState().toggle()
    expect(usePaletteStore.getState().open).toBe(false)
  })
})
