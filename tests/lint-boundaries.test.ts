import { resolve } from 'node:path'

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

const rendererProbe = 'src/renderer/src/__boundary-probe.ts'
const mainProbe = 'src/main/__boundary-probe.ts'
const preloadProbe = 'src/preload/__boundary-probe.ts'
const deeplyNestedRendererProbe = 'src/renderer/src/features/account/overview/__boundary-probe.ts'

describe('process boundaries (ADR 0005 / ADR 0023)', () => {
  it('requires renderer components to consume store hooks instead of atoms and query plumbing', async () => {
    const component = 'src/renderer/src/features/overview/__boundary-probe.tsx'
    for (const source of ['@/app/atoms/scope', '../settings/preferences-atoms', '@/app/hooks/use-remote-query']) {
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
        'src/renderer/src/features/overview/use-overview-store.ts',
      ),
    ).not.toContain('no-restricted-syntax')
    expect(
      await errorRules(
        "import { RegistryContext } from '@effect/atom-react'\nexport const probe = RegistryContext\n",
        'src/renderer/src/app/renderer-root.tsx',
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
      `import type { OverviewScope } from '../../main/overview-scope.js'\nexport type Probe = OverviewScope\n`,
      rendererProbe,
    )
    expect(rules).toContain('import-x/no-restricted-paths')
  })

  it('rejects resolved aliases and deep relative imports across process boundaries', async () => {
    const aliasRules = await errorRules(
      `import { overviewDateRange } from '@/../../main/overview-scope.js'\nexport const probe = overviewDateRange\n`,
      deeplyNestedRendererProbe,
    )
    expect(aliasRules).toContain('import-x/no-restricted-paths')

    const deepRules = await errorRules(
      `import { overviewDateRange } from '../../../../../main/overview-scope.js'\nexport const probe = overviewDateRange\n`,
      deeplyNestedRendererProbe,
    )
    expect(deepRules).toContain('import-x/no-restricted-paths')
  })

  it('rejects renderer imports and DOM globals in main', async () => {
    const importRules = await errorRules(
      `import { localDateKey } from '../renderer/src/shared/lib/utils.js'\nexport const probe = localDateKey\n`,
      mainProbe,
    )
    expect(importRules).toContain('import-x/no-restricted-paths')
    const globalRules = await errorRules(`export const width = window.innerWidth\n`, mainProbe)
    expect(globalRules).toContain('no-restricted-globals')
  })

  it('allows preload shared type imports but rejects value imports from main', async () => {
    const typeRules = await errorRules(
      `import type { OverviewScope } from '../../shared/schemas/overview.js'\nexport type Probe = OverviewScope\n`,
      preloadProbe,
    )
    expect(typeRules).not.toContain('no-restricted-imports')
    const valueRules = await errorRules(
      `import { overviewDateRange } from '../main/overview-scope.js'\nexport const probe = typeof overviewDateRange\n`,
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
    const deepPreloadProbe = 'src/preload/nested/contracts/__boundary-probe.ts'
    const typeRules = await errorRules(
      `import type { OverviewScope } from '../../../main/overview.js'\nexport type Probe = OverviewScope\n`,
      deepPreloadProbe,
    )
    expect(typeRules).not.toContain('no-restricted-imports')
    const valueRules = await errorRules(
      `import { overviewDateRange } from '../../../main/overview-scope.js'\nexport const probe = typeof overviewDateRange\n`,
      deepPreloadProbe,
    )
    expect(valueRules).toContain('no-restricted-imports')
  })
})
