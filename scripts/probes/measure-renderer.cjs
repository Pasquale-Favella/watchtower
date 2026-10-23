const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { performance } = require('node:perf_hooks')

const root = path.resolve(__dirname, '../..')
const fromRoot = createRequire(path.join(root, 'package.json'))
const { _electron: electron } = fromRoot('@playwright/test')
const { prepareProviderFixture } = fromRoot('./scripts/fixtures/provider.cjs')

function parseArgs(args) {
  const options = { appDir: root, runs: 3 }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--app-dir') options.appDir = path.resolve(args[++index])
    else if (argument === '--runs') options.runs = Number(args[++index])
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error('--runs must be an integer from 1 to 10')
  }
  return options
}

function bundleBytes(rendererDir) {
  const files = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(filePath)
      else if (entry.isFile() && ['.js', '.css'].includes(path.extname(entry.name))) {
        files.push({
          path: path.relative(rendererDir, filePath).replaceAll(path.sep, '/'),
          bytes: fs.statSync(filePath).size,
        })
      }
    }
  }
  visit(rendererDir)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    jsBytes: files.filter(file => file.path.endsWith('.js')).reduce((sum, file) => sum + file.bytes, 0),
    cssBytes: files.filter(file => file.path.endsWith('.css')).reduce((sum, file) => sum + file.bytes, 0),
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function closeApp(app) {
  const outcome = await Promise.race([
    app.close().then(
      () => 'closed',
      () => 'failed',
    ),
    delay(8_000).then(() => 'timeout'),
  ])
  if (outcome === 'closed') return outcome

  const child = app.process()
  const hasExited = () => child.exitCode !== null || child.signalCode !== null
  if (!hasExited()) {
    child.kill('SIGKILL')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2_000)])
  }
  if (!hasExited()) throw new Error(`Measured Electron process ${child.pid} did not exit; profile retained`)
  return outcome
}

async function measureRun(appDir, run) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-renderer-measure-'))
  const fixture = prepareProviderFixture(profile)
  let app
  let measurement
  let closeOutcome
  const launchStarted = performance.now()
  console.error(`[renderer measurement ${run}] launch ${appDir}`)
  try {
    app = await electron.launch({
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.', `--user-data-dir=${profile}`],
      cwd: appDir,
      env: fixture.env,
      timeout: 60_000,
    })
    const page = await app.firstWindow({ timeout: 60_000 })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    console.error(`[renderer measurement ${run}] first window ${page.url()}`)
    await page.waitForFunction(
      () => {
        const rootElement = globalThis.document.querySelector('#root')
        return rootElement !== null && rootElement.firstElementChild !== null
      },
      undefined,
      { timeout: 60_000 },
    )
    await page.evaluate(
      () => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
    )
    const firstReactFrameMs = performance.now() - launchStarted
    console.error(`[renderer measurement ${run}] first React frame ${firstReactFrameMs.toFixed(1)} ms`)

    await page.getByRole('button', { name: 'Skip', exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    console.error(`[renderer measurement ${run}] onboarding dismissed`)

    const sessionsStarted = performance.now()
    await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search sessions' }).waitFor({ state: 'visible', timeout: 60_000 })
    const overviewToSessionsMs = performance.now() - sessionsStarted
    console.error(`[renderer measurement ${run}] Sessions ready ${overviewToSessionsMs.toFixed(1)} ms`)

    const overviewStarted = performance.now()
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    await page.getByText('Total spend', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    const sessionsToOverviewMs = performance.now() - overviewStarted
    console.error(`[renderer measurement ${run}] Overview ready ${sessionsToOverviewMs.toFixed(1)} ms`)

    measurement = { run, firstReactFrameMs, overviewToSessionsMs, sessionsToOverviewMs, pageErrors }
  } finally {
    if (app) {
      closeOutcome = await closeApp(app)
      if (closeOutcome !== 'closed') {
        console.error(`[renderer measurement ${run}] forced app process close after ${closeOutcome}`)
      }
    }
    fs.rmSync(profile, { recursive: true, force: true })
  }
  return { ...measurement, closeOutcome }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const rendererDir = path.join(options.appDir, 'out', 'renderer')
  if (!fs.existsSync(rendererDir)) throw new Error(`Renderer build is missing: ${rendererDir}`)
  const bundle = bundleBytes(rendererDir)
  const runs = []
  for (let index = 0; index < options.runs; index += 1) {
    runs.push(await measureRun(options.appDir, index + 1))
  }
  return {
    appDir: options.appDir,
    platform: process.platform,
    architecture: process.arch,
    electronVersion: require(path.join(path.dirname(fromRoot.resolve('electron')), 'package.json')).version,
    fixture: 'scripts/fixtures/provider.cjs; isolated profile per run',
    rendererBundleBytes: bundle,
    runs,
    bridgeCallCount: 'unmeasured; no non-invasive startup hook is available in the current renderer API',
    atomRegistryNodeCount: 'unmeasured; no global count is exposed by the production runtime',
  }
}

main().then(
  result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(0)),
  error => {
    console.error(error)
    process.exit(1)
  },
)
