const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')

const root = path.resolve(__dirname, '../..')
const fromRoot = createRequire(path.join(root, 'package.json'))
const { _electron: electron } = fromRoot('@playwright/test')
const { prepareProviderFixture } = fromRoot('./scripts/fixtures/provider.cjs')

function parseArgs(args) {
  const options = { appDir: root, runs: 3, instrument: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--app-dir') options.appDir = path.resolve(args[++index])
    else if (argument === '--runs') options.runs = Number(args[++index])
    else if (argument === '--instrument') options.instrument = true
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

function removeMeasurementProfile(profile) {
  const absoluteProfile = path.resolve(profile)
  const temporaryRoot = path.resolve(os.tmpdir())
  if (
    path.dirname(absoluteProfile) !== temporaryRoot ||
    !path.basename(absoluteProfile).startsWith('watchtower-renderer-measure-')
  ) {
    throw new Error(`Refusing to remove an unexpected measurement profile: ${absoluteProfile}`)
  }
  if (fs.existsSync(absoluteProfile)) fs.rmSync(absoluteProfile, { recursive: true, force: true })
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
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2_000)])
  }
  if (!hasExited()) throw new Error(`Measured Electron process ${child.pid} did not exit; profile retained`)
  return outcome
}

async function measureRun(options, run) {
  const { appDir } = options
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-renderer-measure-'))
  const scenarioFile = path.join(profile, 'renderer-measurement-scenario.txt')
  const instrumentationFile = path.join(profile, 'renderer-measurement-main.json')
  const setScenario = scenario => fs.writeFileSync(scenarioFile, scenario, 'utf8')
  let app
  let measurement
  let mainInstrumentation
  let closeOutcome
  let appStopped = true
  const launchStarted = performance.now()
  let launchResolvedMs
  let firstWindowResolvedMs
  console.error(`[renderer measurement ${run}] launch ${appDir}`)
  try {
    const fixture = prepareProviderFixture(profile)
    setScenario('boot')
    const appArgs = options.instrument ? path.join(root, 'scripts/probes/measure-renderer-main.cjs') : '.'
    app = await electron.launch({
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), appArgs, `--user-data-dir=${profile}`],
      cwd: appDir,
      env: options.instrument
        ? {
            ...fixture.env,
            WATCHTOWER_MEASURE_APP_DIR: appDir,
            WATCHTOWER_MEASURE_SCENARIO_FILE: scenarioFile,
            WATCHTOWER_MEASURE_REPORT_FILE: instrumentationFile,
          }
        : fixture.env,
      timeout: 60_000,
    })
    appStopped = false
    launchResolvedMs = performance.now() - launchStarted
    const page = await app.firstWindow({ timeout: 60_000 })
    firstWindowResolvedMs = performance.now() - launchStarted
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
    setScenario('onboarding')
    console.error(`[renderer measurement ${run}] first React frame ${firstReactFrameMs.toFixed(1)} ms`)

    await page.getByRole('button', { name: 'Skip', exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    setScenario('overview')
    console.error(`[renderer measurement ${run}] onboarding dismissed`)

    const sessionsStarted = performance.now()
    setScenario('overview-to-sessions')
    await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search sessions' }).waitFor({ state: 'visible', timeout: 60_000 })
    const overviewToSessionsMs = performance.now() - sessionsStarted
    console.error(`[renderer measurement ${run}] Sessions ready ${overviewToSessionsMs.toFixed(1)} ms`)

    const overviewStarted = performance.now()
    setScenario('sessions-to-overview')
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    await page.getByText('Total spend', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    const sessionsToOverviewMs = performance.now() - overviewStarted
    console.error(`[renderer measurement ${run}] Overview ready ${sessionsToOverviewMs.toFixed(1)} ms`)

    measurement = {
      run,
      launchResolvedMs,
      firstWindowResolvedMs,
      firstReactFrameMs,
      overviewToSessionsMs,
      sessionsToOverviewMs,
      pageErrors,
    }
  } finally {
    try {
      if (app) {
        closeOutcome = await closeApp(app)
        appStopped = true
        if (closeOutcome !== 'closed') {
          console.error(`[renderer measurement ${run}] forced app process close after ${closeOutcome}`)
        }
      }
    } finally {
      try {
        mainInstrumentation =
          options.instrument && fs.existsSync(instrumentationFile)
            ? JSON.parse(fs.readFileSync(instrumentationFile, 'utf8'))
            : undefined
      } catch (error) {
        console.error(`[renderer measurement ${run}] failed to read main instrumentation: ${String(error)}`)
      } finally {
        if (appStopped) removeMeasurementProfile(profile)
        else console.error(`[renderer measurement ${run}] profile retained because shutdown was not confirmed`)
      }
    }
  }
  return { ...measurement, closeOutcome, ...(mainInstrumentation ? { mainInstrumentation } : {}) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const rendererDir = path.join(options.appDir, 'out', 'renderer')
  if (!fs.existsSync(rendererDir)) throw new Error(`Renderer build is missing: ${rendererDir}`)
  const bundle = bundleBytes(rendererDir)
  const runs = []
  for (let index = 0; index < options.runs; index += 1) {
    runs.push(await measureRun(options, index + 1))
  }
  return {
    appDir: options.appDir,
    platform: process.platform,
    architecture: process.arch,
    electronVersion: require(path.join(path.dirname(fromRoot.resolve('electron')), 'package.json')).version,
    fixture: 'scripts/fixtures/provider.cjs; isolated profile per run',
    rendererBundleBytes: bundle,
    runs,
    mainInstrumentation: options.instrument
      ? 'instrumented runs use scripts/probes/measure-renderer-main.cjs; timings include instrumentation overhead'
      : 'disabled; pass --instrument to collect worker operation and IPC listener samples',
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
