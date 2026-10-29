import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { paletteOpenAtom, setPaletteOpenAtom, togglePaletteAtom } from '../src/renderer/stores/atoms/palette.js'
import { createRendererRuntimeOwner } from '../src/renderer/app/renderer-runtime.js'
let owner: ReturnType<typeof createRendererRuntimeOwner>
beforeEach(() => {
  owner = createRendererRuntimeOwner()
})
afterEach(() => owner.dispose())
describe('command palette atoms', () => {
  it('opens and closes explicitly', () => {
    expect(owner.registry.get(paletteOpenAtom)).toBe(false)
    owner.registry.set(setPaletteOpenAtom, true)
    expect(owner.registry.get(paletteOpenAtom)).toBe(true)
    owner.registry.set(setPaletteOpenAtom, false)
    expect(owner.registry.get(paletteOpenAtom)).toBe(false)
  })
  it('toggles from either state for the global launcher shortcut', () => {
    owner.registry.set(togglePaletteAtom, undefined)
    expect(owner.registry.get(paletteOpenAtom)).toBe(true)
    owner.registry.set(togglePaletteAtom, undefined)
    expect(owner.registry.get(paletteOpenAtom)).toBe(false)
  })
})
