import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  createDirectoryTreeStateAtom,
  DirectoryRequestCoordinator,
} from '@/renderer/features/workspace/right-panel/use-directory-tree.js'
import type { DirectoryListing } from '@/shared/schemas/checkout-inspection.js'

function listing(path: string, directories: readonly string[]): DirectoryListing {
  return {
    path,
    entries: directories.map(name => ({
      name,
      path: path ? `${path}/${name}` : name,
      kind: 'directory',
      size: null,
    })),
    truncated: false,
  }
}

describe('checkout directory cache', () => {
  it('coalesces one follow-up refresh across tabs when files change during a read', async () => {
    const requests = new DirectoryRequestCoordinator()
    let finish: (() => void) | undefined
    let reads = 0
    const original = requests.run(
      'src',
      () =>
        new Promise<void>(resolve => {
          reads++
          finish = resolve
        }),
    )
    const refresh = async () => {
      reads++
    }
    const firstTab = requests.run('src', refresh, 1)
    const secondTab = requests.run('src', refresh, 1)
    expect(firstTab).toBe(secondTab)
    expect(reads).toBe(1)
    finish?.()
    await Promise.all([original, firstTab, secondTab])
    expect(reads).toBe(2)
  })

  it('owns request coordinators and queues separately in each window registry', () => {
    const atom = createDirectoryTreeStateAtom('checkout')
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()
    try {
      const firstState = first.get(atom)
      const secondState = second.get(atom)
      expect(firstState.requests).not.toBe(secondState.requests)
      expect(firstState.queue).not.toBe(secondState.queue)
      first.set(atom, { path: '', listing: listing('', ['src']) })
      expect(first.get(atom).listings.has('')).toBe(true)
      expect(second.get(atom).listings.size).toBe(0)
      expect(first.get(atom).requests).toBe(firstState.requests)
      expect(firstState.requests.isClosed()).toBe(false)
      first.dispose()
      expect(firstState.requests.isClosed()).toBe(true)
      expect(secondState.requests.isClosed()).toBe(false)
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it('retains identical listings and removes cached descendants when their parent disappears', () => {
    const atom = createDirectoryTreeStateAtom('checkout')
    const registry = AtomRegistry.make()
    try {
      registry.set(atom, { path: '', listing: listing('', ['src']) })
      registry.set(atom, { path: 'src', listing: listing('src', ['lib']) })
      registry.set(atom, { path: 'src/lib', listing: listing('src/lib', []) })
      const cached = registry.get(atom)
      registry.set(atom, { path: '', listing: listing('', ['src']) })
      expect(registry.get(atom)).toBe(cached)
      registry.set(atom, { path: '', listing: listing('', []) })
      expect([...registry.get(atom).listings.keys()]).toEqual([''])
    } finally {
      registry.dispose()
    }
  })
})
