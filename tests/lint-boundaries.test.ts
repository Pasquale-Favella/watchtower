import { dirname, relative, resolve } from 'node:path'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * Lint boundary regression test for the process seams.
 *
 * `eslint.config.mjs` enforces the process seams — sandboxed renderer
 * (ADR 0005), db-worker data plane with no view dependency (ADR 0023) — with
 * `no-restricted-imports`/`no-restricted-globals`. A probe `import` must fail
 * `npm run lint`; this test pins that contract so a future config edit can't
 * silently open the seam. Virtual file paths (no files are written): only the
 * path decides which config block applies.
 */

const eslint = new ESLint()

async function errorRules(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(file) })
  return result.messages.filter(message => message.severity === 2).map(message => String(message.ruleId))
}

const rendererProbe = 'src/renderer/__boundary-probe.ts'
const mainProbe = 'src/platform/electron/main/__boundary-probe.ts'
const preloadProbe = 'src/platform/electron/preload/__boundary-probe.ts'
const deeplyNestedRendererProbe = 'src/renderer/features/account/overview/__boundary-probe.ts'
const engineProbe = 'src/core/application/queries/nested/__boundary-probe.ts'

function sourceImport(file: string, target: string): string {
  const source = relative(dirname(resolve(file)), resolve(target)).replaceAll('\\', '/')
  return source.startsWith('.') ? source : './' + source
}

describe('engine dependency boundaries (ADR 0038)', () => {
  it('rejects desktop, renderer and preload dependencies, including types and resolved aliases', async () => {
    for (const source of [
      sourceImport(engineProbe, 'src/platform/electron/main/main-runtime.ts'),
      sourceImport(engineProbe, 'src/infrastructure/runtime/engine-runtime.ts'),
      sourceImport(engineProbe, 'src/platform/electron/preload/rpc.ts'),
      sourceImport(engineProbe, 'src/renderer/shared/lib/utils.ts'),
    ]) {
      for (const qualifier of ['', 'type ']) {
        expect(
          await errorRules(`import ${qualifier}* as dependency from '${source}'\nexport { dependency }\n`, engineProbe),
        ).toContain('import-x/no-restricted-paths')
      }
    }
    expect(
      await errorRules("import * as dependency from '@/shared/lib/utils'\nexport { dependency }\n", engineProbe),
    ).toContain('no-restricted-imports')
  })

  it('rejects Electron and React dependencies even when only their types are imported', async () => {
    for (const source of [
      'electron',
      'electron/main',
      'electron-updater',
      'react',
      'react/jsx-runtime',
      'react-dom/client',
      '@effect/atom-react',
    ]) {
      for (const qualifier of ['', 'type ']) {
        expect(
          await errorRules(`import ${qualifier}* as dependency from '${source}'\nexport { dependency }\n`, engineProbe),
        ).toContain('no-restricted-imports')
      }
    }
  })

  it('keeps engine implementations out of renderer, preload and shared contracts', async () => {
    for (const probe of [rendererProbe, preloadProbe, 'src/shared/__boundary-probe.ts']) {
      expect(
        await errorRules(
          `import type { EngineRuntime } from '${sourceImport(probe, 'src/infrastructure/runtime/engine-runtime.ts')}'\nexport type Probe = EngineRuntime\n`,
          probe,
        ),
      ).toContain('import-x/no-restricted-paths')
    }
  })

  it('allows Node and shared contracts in the engine, and engine queries in desktop adapters', async () => {
    expect(
      await errorRules("import { readFileSync } from 'node:fs'\nexport const probe = readFileSync\n", engineProbe),
    ).toEqual([])
    expect(
      await errorRules(
        `import type { OverviewScope } from '${sourceImport(engineProbe, 'src/shared/schemas/overview.ts')}'\nexport type Probe = OverviewScope\n`,
        engineProbe,
      ),
    ).toEqual([])
    expect(
      await errorRules(
        `import { openEngineRuntime } from '${sourceImport(mainProbe, 'src/infrastructure/runtime/engine-runtime.ts')}'\nexport const probe = openEngineRuntime\n`,
        mainProbe,
      ),
    ).toEqual([])
  })
})

describe('process boundaries (ADR 0005 / ADR 0023)', () => {
  it('requires renderer components to consume store hooks instead of atoms and query plumbing', async () => {
    const component = 'src/renderer/features/overview/__boundary-probe.tsx'
    for (const source of ['@/stores/atoms/scope', '../settings/preferences-atoms', '@/stores/hooks/use-remote-query']) {
      expect(await errorRules(`import * as state from '${source}'\nexport const probe = state\n`, component)).toContain(
        'import-x/no-restricted-paths',
      )
    }
    for (const source of ['@effect/atom-react', 'effect/reactivity/Atom']) {
      expect(await errorRules(`import * as state from '${source}'\nexport const probe = state\n`, component)).toContain(
        'no-restricted-syntax',
      )
    }
    expect(
      await errorRules(
        "import { useOverviewStore } from './use-overview-store'\nexport const probe = useOverviewStore\n",
        component,
      ),
    ).not.toContain('import-x/no-restricted-paths')
    expect(
      await errorRules(
        "import { useAtomValue } from '@effect/atom-react'\nexport const probe = useAtomValue\n",
        'src/renderer/features/overview/use-overview-store.ts',
      ),
    ).not.toContain('no-restricted-syntax')
    expect(
      await errorRules(
        "import { RegistryContext } from '@effect/atom-react'\nexport const probe = RegistryContext\n",
        'src/renderer/app/renderer-root.tsx',
      ),
    ).not.toContain('no-restricted-syntax')
  })
  it('rejects Electron imports in the renderer', async () => {
    const rules = await errorRules(
      `import { ipcRenderer } from 'electron'\nexport const probe = typeof ipcRenderer\n`,
      rendererProbe,
    )
    expect(rules).toContain('no-restricted-imports')
  })

  it('rejects Node imports in the renderer, bare and prefixed', async () => {
    for (const source of ['node:fs', 'fs', 'fs/promises', 'stream', 'stream/web', 'node:path', 'buffer']) {
      const rules = await errorRules(
        `import { join } from '${source}'\nexport const probe = typeof join\n`,
        rendererProbe,
      )
      expect(rules).toContain('no-restricted-imports')
    }
  })

  it('rejects main/preload source imports from the renderer', async () => {
    const rules = await errorRules(
      `import type { MainRuntime } from '../platform/electron/main/main-runtime.js'\nexport type Probe = MainRuntime\n`,
      rendererProbe,
    )
    expect(rules).toContain('import-x/no-restricted-paths')
  })

  it('rejects resolved aliases and deep relative imports across process boundaries', async () => {
    const aliasRules = await errorRules(
      `import { makeMainRuntime } from '@/../platform/electron/main/main-runtime.js'\nexport const probe = makeMainRuntime\n`,
      deeplyNestedRendererProbe,
    )
    expect(aliasRules).toContain('import-x/no-restricted-paths')

    const deepRules = await errorRules(
      `import { makeMainRuntime } from '../../../../platform/electron/main/main-runtime.js'\nexport const probe = makeMainRuntime\n`,
      deeplyNestedRendererProbe,
    )
    expect(deepRules).toContain('import-x/no-restricted-paths')
  })

  it('rejects renderer imports and DOM globals in main', async () => {
    const importRules = await errorRules(
      `import { localDateKey } from '../../../renderer/shared/lib/utils.js'\nexport const probe = localDateKey\n`,
      mainProbe,
    )
    expect(importRules).toContain('import-x/no-restricted-paths')
    const globalRules = await errorRules(`export const width = window.innerWidth\n`, mainProbe)
    expect(globalRules).toContain('no-restricted-globals')
  })

  it('allows preload shared type imports but rejects value imports from main', async () => {
    const typeRules = await errorRules(
      `import type { MainRuntime } from '../../shared/schemas/overview.js'\nexport type Probe = MainRuntime\n`,
      preloadProbe,
    )
    expect(typeRules).not.toContain('no-restricted-imports')
    const valueRules = await errorRules(
      `import { makeMainRuntime } from '../main/main-runtime.js'\nexport const probe = typeof makeMainRuntime\n`,
      preloadProbe,
    )
    expect(valueRules).toContain('no-restricted-imports')
  })

  it('allows shared imports from the renderer', async () => {
    const rules = await errorRules(
      `import * as Schema from 'effect/Schema'\nexport const probe = Schema.String\n`,
      rendererProbe,
    )
    expect(rules).not.toContain('no-restricted-imports')
    const streamRules = await errorRules(
      `import * as Stream from 'effect/Stream'\nexport const probe = Stream.empty\n`,
      rendererProbe,
    )
    expect(streamRules).not.toContain('no-restricted-imports')
  })

  it('allows a preload type import from main and rejects its value import at arbitrary depth', async () => {
    const deepPreloadProbe = 'src/platform/electron/preload/nested/contracts/__boundary-probe.ts'
    const typeRules = await errorRules(
      `import type { MainRuntime } from '../../../main/main-runtime.js'\nexport type Probe = MainRuntime\n`,
      deepPreloadProbe,
    )
    expect(typeRules).not.toContain('no-restricted-imports')
    const valueRules = await errorRules(
      `import { makeMainRuntime } from '../../../main/main-runtime.js'\nexport const probe = typeof makeMainRuntime\n`,
      deepPreloadProbe,
    )
    expect(valueRules).toContain('no-restricted-imports')
  })
})
