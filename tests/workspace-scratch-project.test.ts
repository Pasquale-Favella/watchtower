import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { ensureScratchProject } from '@/platform/electron/main/workspace/scratch-project.js'

describe('managed chat checkout', () => {
  it('creates one persistent context, reuses its identity and refuses a missing registered checkout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-scratch-'))
    const checkoutPath = join(directory, 'scratch')
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(WorkspaceStoreLive({ filename: ':memory:' }), CheckoutResolverLive).pipe(
        Layer.provideMerge(CommandRunnerLive),
        Layer.provideMerge(NodePlatformLive),
      ),
    )
    try {
      expect(existsSync(checkoutPath)).toBe(false)
      const store = await runtime.runPromise(WorkspaceStore)
      const first = await runtime.runPromise(ensureScratchProject(store, checkoutPath))
      expect(first.project.isScratch).toBe(true)
      expect(first.project.name).toBe('No project')
      expect(existsSync(join(checkoutPath, '.git'))).toBe(true)
      const again = await runtime.runPromise(ensureScratchProject(store, checkoutPath))
      expect(again.project).toEqual(first.project)
      expect(again.mainCheckout).toEqual(first.mainCheckout)
      expect(again.reused).toBe(true)
      expect((await runtime.runPromise(store.listProjects())).total).toBe(1)
      rmSync(checkoutPath, { recursive: true, force: true })
      const missing = await runtime.runPromise(Effect.result(ensureScratchProject(store, checkoutPath)))
      expect(missing._tag).toBe('Failure')
      expect(existsSync(checkoutPath)).toBe(false)
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
