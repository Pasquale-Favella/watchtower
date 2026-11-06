const { readFileSync } = require('node:fs')

/**
 * A passing Vitest process is not enough: on Linux, skipIf(win32) silently
 * bypasses these assertions. Fail Windows CI if any of them is absent/skipped.
 */
const expected = {
  'claude-app-paths.test.ts': [
    'APPDATA / LOCALAPPDATA are honored, null and "" fall back per the || chain',
    'the cache key keeps appData participating: two roots are two entries',
  ],
  'copilot-app-paths.test.ts': [
    'APPDATA: the snapshot root is the root, and "" never becomes the homedir default',
    'LOCALAPPDATA: the snapshot root is used, null falls back to homedir',
  ],
  'provider-app-paths.test.ts': ['a threaded LOCALAPPDATA root is honored on win32'],
  'antigravity-rpc-effect.test.ts': [
    'accepts probe headers without waiting for or reading the unused response body',
  ],
}

function verify(report) {
  if (process.platform !== 'win32') throw new Error('The win32 regression gate must run on a Windows host.')
  if (report.success !== true || !Array.isArray(report.testResults))
    throw new Error('Vitest did not produce a successful JSON report.')

  let verified = 0
  for (const [filename, titles] of Object.entries(expected)) {
    const suites = report.testResults.filter(suite =>
      typeof suite.name === 'string' && suite.name.replace(/\\/g, '/').endsWith('/tests/' + filename),
    )
    if (suites.length !== 1) throw new Error(filename + ': expected one executed suite, got ' + suites.length)

    const assertions = suites[0].assertionResults
    if (!Array.isArray(assertions)) throw new Error(filename + ': missing assertion results')
    for (const title of titles) {
      const matches = assertions.filter(assertion => assertion.title === title)
      if (matches.length !== 1 || matches[0].status !== 'passed') {
        throw new Error(
          filename + ': Windows-only test not executed successfully: ' + title +
            ' (status: ' + (matches[0]?.status ?? 'missing') + ')',
        )
      }
      verified += 1
      console.log('PASS ' + filename + ': ' + title)
    }
  }
  console.log('Verified ' + verified + ' Windows-only assertions across ' + Object.keys(expected).length + ' suites.')
}

try {
  const reportFile = process.argv[2]
  if (!reportFile) throw new Error('Usage: node scripts/ci-verify-win32-tests.cjs <vitest-json-report>')
  verify(JSON.parse(readFileSync(reportFile, 'utf8')))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
