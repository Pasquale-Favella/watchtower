import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const cli = resolve(root, 'node_modules/@effect/tsgo/dist/effect-tsgo.cjs')

function diagnostics(project) {
  return spawnSync(
    process.execPath,
    [cli, 'diagnostics', '--project', resolve(root, project), '--severity', 'error', '--format', 'text'],
    { cwd: root, encoding: 'utf8' },
  )
}

const positive = diagnostics('tsconfig.effect-probe-positive.json')
if (positive.error || positive.status !== 0 || /effect\(floatingEffect\)/.test(positive.stdout + positive.stderr)) {
  process.stderr.write('Effect diagnostic positive fixture failed.\n')
  process.stderr.write(positive.stderr || positive.stdout || String(positive.error))
  process.exitCode = 1
} else {
  const negative = diagnostics('tsconfig.effect-probe-negative.json')
  const output = negative.stdout + negative.stderr
  if (negative.error || negative.status === 0 || !/error effect\(floatingEffect\)/.test(output)) {
    process.stderr.write('Effect diagnostic negative fixture was not rejected by floatingEffect.\n')
    process.stderr.write(negative.stderr || negative.stdout || String(negative.error))
    process.exitCode = 1
  }
}

if (process.exitCode) process.exit(process.exitCode)
