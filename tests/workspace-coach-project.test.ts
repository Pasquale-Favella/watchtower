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
import { ensureCoachProject } from '@/platform/electron/main/workspace/coach-project.js'

describe('managed Coach checkout', () => {
  it('creates one persistent context, reuses its identity and refuses a missing registered checkout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-coach-'))
    const checkoutPath = join(directory, 'coach')
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(WorkspaceStoreLive({ filename: ':memory:' }), CheckoutResolverLive).pipe(
        Layer.provideMerge(CommandRunnerLive),
        Layer.provideMerge(NodePlatformLive),
      ),
    )
    try {
      expect(existsSync(checkoutPath)).toBe(false)
      const store = await runtime.runPromise(WorkspaceStore)
      const first = await runtime.runPromise(ensureCoachProject(store, checkoutPath))
      expect(first.project.isCoach).toBe(true)
      expect(first.project.name).toBe('Coach')
      expect(existsSync(join(checkoutPath, '.git'))).toBe(true)
      const again = await runtime.runPromise(ensureCoachProject(store, checkoutPath))
      expect(again.project).toEqual(first.project)
      expect(again.mainCheckout).toEqual(first.mainCheckout)
      expect(again.reused).toBe(true)
      expect((await runtime.runPromise(store.listProjects())).total).toBe(0)
      rmSync(checkoutPath, { recursive: true, force: true })
      const missing = await runtime.runPromise(Effect.result(ensureCoachProject(store, checkoutPath)))
      expect(missing._tag).toBe('Failure')
      expect(existsSync(checkoutPath)).toBe(false)
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
