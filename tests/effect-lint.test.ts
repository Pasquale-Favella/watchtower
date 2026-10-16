import { resolve } from 'node:path'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const nonRootProbe = 'src/main/application/__effect-lint-probe.ts'

async function ruleIds(code: string, file = nonRootProbe): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(file) })
  return result.messages.map(message => String(message.ruleId))
}

describe('Effect-specific architecture lint', () => {
  it('enforces Effect subpath imports in production source', async () => {
    const barrelRules = await ruleIds(`import { Effect } from 'effect'\nexport const result = Effect.succeed(1)\n`)
    expect(barrelRules).toContain('effect/no-import-from-barrel-package')

    const subpathRules = await ruleIds(
      `import * as Effect from 'effect/Effect'\nexport const result = Effect.succeed(1)\n`,
    )
    expect(subpathRules).not.toContain('effect/no-import-from-barrel-package')
  })

  it('recognizes namespace aliases and direct Effect runtime imports', async () => {
    const namespaceRules = await ruleIds(
      `import { Effect as FX } from 'effect'\nexport const result = FX.runPromise(FX.succeed(1))\n`,
    )
    expect(namespaceRules).toContain('watchtower-effect/no-run-outside-composition-root')

    const directRules = await ruleIds(
      `import { runPromise as execute } from 'effect/Effect'\nimport { Effect } from 'effect'\nexport const result = execute(Effect.succeed(1))\n`,
    )
    expect(directRules).toContain('watchtower-effect/no-run-outside-composition-root')

    const barrelNamespaceRules = await ruleIds(
      `import * as EF from 'effect'\nexport const result = EF.Effect.runPromise(EF.Effect.succeed(1))\n`,
    )
    expect(barrelNamespaceRules).toContain('watchtower-effect/no-run-outside-composition-root')
  })

  it('flags throws executed by Effect.sync but allows adapted and deferred throws', async () => {
    const defectRules = await ruleIds(
      `import { Effect as FX } from 'effect'\nexport const defect = FX.sync(() => { throw new Error('defect') })\n`,
    )
    expect(defectRules).toContain('watchtower-effect/no-bare-throw-in-sync')

    const tryRules = await ruleIds(
      `import { Effect } from 'effect'\nexport const failure = Effect.try({ try: () => { throw new Error('foreign') }, catch: error => error })\n`,
    )
    expect(tryRules).not.toContain('watchtower-effect/no-bare-throw-in-sync')

    const promiseRules = await ruleIds(
      `import * as FX from 'effect/Effect'\nexport const failure = FX.tryPromise({ try: async () => { throw new Error('foreign') }, catch: error => error })\n`,
    )
    expect(promiseRules).not.toContain('watchtower-effect/no-bare-throw-in-sync')

    const caughtRules = await ruleIds(
      `import { sync as effectSync } from 'effect/Effect'\nexport const caught = effectSync(() => { try { throw new Error('caught') } catch { return 0 } })\n`,
    )
    expect(caughtRules).not.toContain('watchtower-effect/no-bare-throw-in-sync')

    const deferredRules = await ruleIds(
      `import { Effect } from 'effect'\nexport const task = Effect.sync(() => () => { throw new Error('later') })\n`,
    )
    expect(deferredRules).not.toContain('watchtower-effect/no-bare-throw-in-sync')
  })
})
