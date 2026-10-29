import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)

function removeFixtureDirectory(directory: string, fixtureRoot: string): void {
  const target = resolve(directory)
  if (dirname(target) !== fixtureRoot || !basename(target).startsWith('engine-node-smoke-')) {
    throw new Error('Unexpected engine smoke fixture directory')
  }
  rmSync(target, { recursive: true, force: true })
}

describe('Watchtower Engine in plain Node', () => {
  it('ingests and queries a temporary ledger without desktop or harness implementations', async () => {
    const fixtureRoot = resolve('node_modules')
    const directory = mkdtempSync(join(fixtureRoot, 'engine-node-smoke-'))
    try {
      const entry = join(directory, 'engine.mjs')
      const bundled = await build({
        entryPoints: ['tests/fixtures/engine-node-smoke.ts'],
        outfile: entry,
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        metafile: true,
      })
      expect(
        Object.keys(bundled.metafile.inputs).filter(file =>
          /^src\/(platform|renderer|infrastructure\/agent-harnesses)\//.test(file),
        ),
      ).toEqual([])
      const imports = Object.values(bundled.metafile.inputs).flatMap(input => input.imports.map(item => item.path))
      expect(
        imports.filter(specifier => /^(electron|react|@agentclientprotocol\/|@mcpc-tech\/|ai$)/.test(specifier)),
      ).toEqual([])

      const { stdout } = await execute(process.execPath, [entry, join(directory, 'ledger.db')], {
        timeout: 15_000,
        windowsHide: true,
      })
      expect(JSON.parse(stdout)).toMatchObject({ calls: 1 })
    } finally {
      removeFixtureDirectory(directory, fixtureRoot)
    }
  })
})
