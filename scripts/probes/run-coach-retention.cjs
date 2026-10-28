const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { build } = require('esbuild')

const root = path.resolve(__dirname, '../..')
const rawGitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim()
const gitDir = path.resolve(root, rawGitDir)
const temporaryDir = fs.mkdtempSync(path.join(gitDir, 'coach-retention-probe-'))
const outputFile = path.join(gitDir, 'm3-coach-retention.json')

function removeTemporaryDirectory() {
  const absoluteTarget = path.resolve(temporaryDir)
  if (path.dirname(absoluteTarget) !== gitDir || !path.basename(absoluteTarget).startsWith('coach-retention-probe-')) {
    throw new Error(`Refusing to remove an unexpected temporary directory: ${absoluteTarget}`)
  }
  fs.rmSync(absoluteTarget, { recursive: true, force: true })
}

async function main() {
  try {
    const entry = path.join(temporaryDir, 'measure-coach-retention.mjs')
    await build({
      entryPoints: [path.join(root, 'scripts/probes/measure-coach-retention.ts')],
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      alias: { '@': path.join(root, 'src/renderer/src') },
      logLevel: 'silent',
    })
    execFileSync(process.execPath, [entry, outputFile], { cwd: root, stdio: 'inherit' })
  } finally {
    removeTemporaryDirectory()
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
