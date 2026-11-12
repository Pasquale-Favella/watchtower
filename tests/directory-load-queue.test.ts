import { describe, expect, it } from 'vitest'

import { reconcileExpandedDirectories } from '../src/renderer/features/workspace/right-panel/directory-tree-loading.js'
import {
  DirectoryLoadQueue,
  DirectoryRequestCoordinator,
} from '../src/renderer/features/workspace/right-panel/use-directory-tree.js'

describe('directory load queue', () => {
  it('shares an in-flight directory read across file explorers in one checkout', async () => {
    const requests = new DirectoryRequestCoordinator()
    let calls = 0
    let finish: (() => void) | undefined
    const work = () => {
      calls++
      return new Promise<void>(resolve => {
        finish = resolve
      })
    }
    const first = requests.run('project-a:checkout-a:src', work)
    const second = requests.run('project-a:checkout-a:src', work)
    expect(calls).toBe(1)
    finish?.()
    await Promise.all([first, second])

    const otherCheckout = requests.run('project-a:checkout-b:src', async () => {
      calls++
    })
    await otherCheckout
    expect(calls).toBe(2)
  })

  it('loads only newly expanded folders and forgets collapsed folders', () => {
    const initial = reconcileExpandedDirectories(['src/', 'src/lib/'], new Set(), path => path === 'src/')
    expect(initial.newlyExpanded).toEqual(['src/'])

    const unchanged = reconcileExpandedDirectories(['src/', 'src/lib/'], initial.paths, path => path === 'src/')
    expect(unchanged.newlyExpanded).toEqual([])

    const collapsed = reconcileExpandedDirectories(['src/', 'src/lib/'], unchanged.paths, () => false)
    const expandedAgain = reconcileExpandedDirectories(['src/', 'src/lib/'], collapsed.paths, path => path === 'src/')
    expect(expandedAgain.newlyExpanded).toEqual(['src/'])
  })

  it('bounds independent filesystem requests while settling the entire expansion', async () => {
    const queue = new DirectoryLoadQueue(2)
    const finish: (() => void)[] = []
    let active = 0
    let maximum = 0
    const requests = Array.from({ length: 6 }, () =>
      queue.run(async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise<void>(resolve => {
          finish.push(resolve)
        })
        active--
      }),
    )
    expect(finish.length).toBe(2)
    while (active > 0) {
      finish.splice(0).forEach(resolve => resolve())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await Promise.all(requests)
    expect(maximum).toBe(2)
  })

  it('drops queued work on owner cleanup and continues after an independent failure', async () => {
    const queue = new DirectoryLoadQueue(1)
    let finish: (() => void) | undefined
    let started = 0
    const first = queue.run(
      () =>
        new Promise<void>(resolve => {
          started++
          finish = resolve
        }),
    )
    const second = queue.run(async () => {
      started++
    })
    queue.close()
    await second
    expect(started).toBe(1)
    finish?.()
    await first

    const next = new DirectoryLoadQueue(1)
    const failed = next.run(async () => {
      throw new Error('Unavailable')
    })
    const succeeded = next.run(async () => {
      started++
    })
    await expect(failed).rejects.toThrow('Unavailable')
    await succeeded
    expect(started).toBe(2)
  })
})
