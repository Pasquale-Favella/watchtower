const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const installerInputs = new Set([
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.node-version',
  '.nvmrc',
  'electron-builder.yml',
  'electron-builder.config.cjs',
  'scripts/verify-packaged.cjs',
  'scripts/verify-installer-artifacts.cjs',
  'scripts/prepare-release-artifacts.cjs',
  'scripts/ci-changes.cjs',
  'scripts/ensure-electron.cjs',
  'scripts/generate-icons.cjs',
])

function classifyChanges(files) {
  const installers = files.some(
    file => installerInputs.has(file) || file.startsWith('build/') || file.startsWith('.github/workflows/'),
  )
  const runtime =
    installers || files.some(file => /^(src\/|e2e\/|electron\.vite\.config\.ts$|playwright\.config\.ts$)/.test(file))
  const checks = files.some(file => !/^(?:README\.md|CONTEXT\.md|AGENTS\.md|docs\/.*\.md|\.agents\/.*\.md)$/.test(file))
  return { checks, runtime, installers }
}

if (require.main === module) {
  const base = process.env.CI_BASE_SHA
  const changes = base
    ? classifyChanges(
        execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { encoding: 'utf8' })
          .split('\0')
          .filter(Boolean),
      )
    : { checks: true, runtime: true, installers: true }
  for (const [name, value] of Object.entries(changes)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  }
}

module.exports = { classifyChanges }
