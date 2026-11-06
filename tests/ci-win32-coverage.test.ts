import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type WindowsCase = { file: string; title: string }

const require = createRequire(import.meta.url)
const { discoverWindowsTests, suitesToRun, verify } = require('../scripts/ci-verify-win32-tests.cjs') as {
  discoverWindowsTests: (root: string) => WindowsCase[]
  suitesToRun: (cases: WindowsCase[]) => string[]
  verify: (report: unknown, cases: WindowsCase[]) => void
}

function withTestFiles(files: Record<string, string>, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'watchtower-ci-win32-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      const fullPath = join(root, 'tests', name)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, source)
    }
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('Windows CI coverage inventory', () => {
  it('discovers guarded cases using direct, alias and runIf predicates (not POSIX guards)', () => {
    withTestFiles(
      {
        'additional.test.ts': [
          "const isWindows = process.platform === 'win32'",
          "describe('platform', () => {",
          "  it.skipIf(process.platform !== 'win32')('direct', () => {})",
          "  it.skipIf(!isWindows)('aliased', () => {})",
          "  test.runIf(osPlatform() === 'win32')('run-if', () => {})",
          "  it.skipIf(isWindows)('posix-only', () => {})",
          '})',
        ].join('\n'),
      },
      root => {
        expect(discoverWindowsTests(root)).toEqual([
          { file: 'tests/additional.test.ts', title: 'direct' },
          { file: 'tests/additional.test.ts', title: 'aliased' },
          { file: 'tests/additional.test.ts', title: 'run-if' },
        ])
      },
    )
  })

  it('automatically includes any new suite while preserving native process smoke coverage', () => {
    withTestFiles(
      {
        'new/provider.test.ts': "it.skipIf(process.platform !== 'win32')('new case', () => {})",
      },
      root => {
        const cases = discoverWindowsTests(root)
        expect(suitesToRun(cases)).toContain('tests/new/provider.test.ts')
        expect(suitesToRun(cases)).toContain('tests/command-runner-start.test.ts')
        expect(suitesToRun(cases)).toHaveLength(5)
      },
    )
  })

  it('fails closed when a conditional test uses an unsupported predicate', () => {
    withTestFiles(
      {
        'unknown.test.ts': "it.skipIf(process.env.SKIP_NATIVE)('unknown condition', () => {})",
      },
      root => expect(() => discoverWindowsTests(root)).toThrow('unsupported platform guard'),
    )
  })

  it('requires discovered Windows cases to be executed and passed in the actual report', () => {
    const cases = [{ file: 'tests/new.test.ts', title: 'new Windows assertion' }]
    const report = {
      success: true,
      testResults: [
        { name: 'C:\\repo\\tests\\new.test.ts', assertionResults: [{ title: cases[0].title, status: 'passed' }] },
      ],
    }
    expect(() => verify(report, cases)).not.toThrow()
    expect(() =>
      verify(
        {
          ...report,
          testResults: [{ ...report.testResults[0], assertionResults: [{ title: cases[0].title, status: 'pending' }] }],
        },
        cases,
      ),
    ).toThrow('not passed')
    expect(() => verify({ ...report, testResults: [] }, cases)).toThrow('expected exactly one executed suite')
  })

  it('detects the previously uncovered Windows worker-path regression on the actual repo', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(discoverWindowsTests(root)).toContainEqual({
      file: 'tests/command-runner-worker-path.test.ts',
      title: 'runs raw Git format arguments with only a mixed-case Path key',
    })
  })
})
