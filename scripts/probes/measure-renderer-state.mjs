import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { build, createLogger } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'package.json'))
const { _electron: electron } = require('@playwright/test')
const { prepareProviderFixture } = require(path.join(root, 'scripts/fixtures/provider.cjs'))

const sections = [
  ['Overview', 'Overview'],
  ['Sessions', 'Sessions'],
  ['Pull requests', 'Pull requests'],
  ['Spend', 'Spend'],
  ['Optimize', 'Optimize'],
  ['Models', 'Models'],
  ['Compare', 'Compare'],
]
const periods = ['week', '30days', 'month', 'all', 'lifetime', 'today']
const scopeVisitCount = 20
const sampleIntervalMs = 150
const stableSamplesRequired = 4
const stableTimeoutMs = 10_000
const rpcQueryKey = /^AtomRpc:(.*):selection-\d+$/
const stderrWriter = (...values) => process.stderr.write(`${values.map(String).join(' ')}\n`)
const viteLogger = createLogger('info', {
  allowClearScreen: false,
  console: { log: stderrWriter, warn: stderrWriter, error: stderrWriter },
})

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function removeGeneratedDirectory(target, expectedParent, expectedPrefix) {
  const absoluteTarget = path.resolve(target)
  const absoluteParent = path.resolve(expectedParent)
  if (path.dirname(absoluteTarget) !== absoluteParent || !path.basename(absoluteTarget).startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove an unexpected generated directory: ${absoluteTarget}`)
  }
  if (fs.existsSync(absoluteTarget)) fs.rmSync(absoluteTarget, { recursive: true, force: true })
}

function copyDirectory(source, target) {
  fs.cpSync(source, target, { recursive: true })
}

function stateProbePlugin() {
  return {
    name: 'watchtower-test-only-renderer-state-probe',
    enforce: 'post',
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/')
      if (!normalizedId.endsWith('/src/renderer/app/renderer-runtime.ts')) return null

      return `${code}

;(window).__watchtowerRendererStateProbe = {
  metrics: (() => {
    const peak = {
      registryNodeCount: 0,
      atomRpcSerializableMemberCount: 0,
      queryMemberCount: 0,
      queryMembersByRpc: {},
    }
    const sample = () => {
      const keys = Array.from(registry.getNodes().keys())
      const atomRpcMemberKeys = keys.filter(key => typeof key === 'string' && key.startsWith('AtomRpc:'))
      const queryMembersByRpc = {}
      for (const key of atomRpcMemberKeys) {
        const match = /^AtomRpc:(.*):selection-\\d+$/.exec(key)
        if (match) queryMembersByRpc[match[1]] = (queryMembersByRpc[match[1]] ?? 0) + 1
      }
      const queryMemberCount = Object.values(queryMembersByRpc).reduce((total, count) => total + count, 0)
      const registryNodeCount = keys.length
      if (registryNodeCount > peak.registryNodeCount) peak.registryNodeCount = registryNodeCount
      if (atomRpcMemberKeys.length > peak.atomRpcSerializableMemberCount)
        peak.atomRpcSerializableMemberCount = atomRpcMemberKeys.length
      if (queryMemberCount > peak.queryMemberCount) {
        peak.queryMemberCount = queryMemberCount
        peak.queryMembersByRpc = queryMembersByRpc
      }
    }
    const previousNodeAdded = registry.onNodeAdded
    const previousNodeRemoved = registry.onNodeRemoved
    registry.onNodeAdded = node => {
      try {
        previousNodeAdded?.call(registry, node)
      } finally {
        sample()
      }
    }
    registry.onNodeRemoved = node => {
      try {
        previousNodeRemoved?.call(registry, node)
      } finally {
        sample()
      }
    }
    sample()
    return () => ({ ...peak, queryMembersByRpc: { ...peak.queryMembersByRpc } })
  })(),
  snapshot: () => ({
    nodeCount: registry.getNodes().size,
    atomRpcMemberKeys: Array.from(registry.getNodes().keys()).filter(
      key => typeof key === 'string' && key.startsWith('AtomRpc:'),
    ),
    peak: globalThis.__watchtowerRendererStateProbe.metrics(),
  }),
  period: () => registry.get(periodAtom),
  setPeriod: value => registry.set(periodAtom, value),
  dispose: () => {
    rendererRuntimeOwner.dispose()
    return registry.getNodes().size
  },
}
`
    },
  }
}

async function buildArtifact(artifactDir) {
  const rendererDir = path.join(artifactDir, 'out', 'renderer')
  await build({
    configFile: false,
    customLogger: viteLogger,
    root: path.join(root, 'src/renderer'),
    base: './',
    envDir: root,
    envPrefix: ['RENDERER_VITE_', 'VITE_'],
    plugins: [react(), tailwindcss(), stateProbePlugin()],
    resolve: { alias: { '@': path.join(root, 'src/renderer') } },
    build: {
      outDir: rendererDir,
      target: 'chrome142',
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: path.join(root, 'src/renderer/index.html'),
          orb: path.join(root, 'src/renderer/orb.html'),
          'orb-panel': path.join(root, 'src/renderer/orb-panel.html'),
        },
      },
    },
  })

  const outputDir = path.join(artifactDir, 'out')
  copyDirectory(path.join(root, 'out', 'main'), path.join(outputDir, 'main'))
  copyDirectory(path.join(root, 'out', 'preload'), path.join(outputDir, 'preload'))
  fs.copyFileSync(path.join(root, 'package.json'), path.join(artifactDir, 'package.json'))
  return rendererDir
}

function summarizeRegistrySnapshot(snapshot) {
  const queryMembersByRpc = {}
  let queryMemberCount = 0
  for (const key of snapshot.atomRpcMemberKeys) {
    const match = key.match(rpcQueryKey)
    if (!match) continue
    queryMemberCount += 1
    queryMembersByRpc[match[1]] = (queryMembersByRpc[match[1]] ?? 0) + 1
  }
  return {
    registryNodeCount: snapshot.nodeCount,
    atomRpcSerializableMemberCount: snapshot.atomRpcMemberKeys.length,
    queryMemberCount,
    queryMembersByRpc,
    observedPeak: snapshot.peak,
  }
}

async function readRegistrySnapshot(page) {
  const snapshot = await page.evaluate(() => globalThis.__watchtowerRendererStateProbe.snapshot())
  return summarizeRegistrySnapshot(snapshot)
}

async function readNativeWindowInventory(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(window => {
      let pathname
      try {
        pathname = new URL(window.webContents.getURL()).pathname
      } catch {
        pathname = ''
      }
      const name = pathname.endsWith('/index.html')
        ? 'main'
        : pathname.endsWith('/orb.html')
          ? 'orb'
          : pathname.endsWith('/orb-panel.html')
            ? 'panel'
            : 'other'
      return {
        name,
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
        loading: window.webContents.isLoading(),
        focused: window.isFocused(),
      }
    }),
  )
}

async function readOrbPanelToggle(page) {
  return page.locator('button[aria-label*="Watchtower panel"]').evaluateAll(buttons =>
    buttons.map(button => ({
      ariaLabel: button.getAttribute('aria-label'),
      ariaExpanded: button.getAttribute('aria-expanded'),
      dataState: button.getAttribute('data-state'),
      disabled: button.disabled,
    })),
  )
}

async function waitForWindowPage(app, urlSuffix) {
  const started = performance.now()
  while (performance.now() - started < 30_000) {
    const page = app.windows().find(candidate => candidate.url().endsWith(urlSuffix))
    if (page) {
      await page.waitForFunction(
        () => globalThis.document.querySelector('#root')?.firstElementChild !== null,
        undefined,
        { timeout: 30_000 },
      )
      return page
    }
    await delay(100)
  }
  throw new Error(`Electron window did not open: ${urlSuffix}`)
}

async function waitForNativeWindowVisibility(app, urlSuffix, expectedVisibility) {
  const started = performance.now()
  while (performance.now() - started < 30_000) {
    const visible = await app.evaluate(
      ({ BrowserWindow }, suffix) =>
        BrowserWindow.getAllWindows()
          .find(window => window.webContents.getURL().endsWith(suffix))
          ?.isVisible() ?? false,
      urlSuffix,
    )
    if (visible === expectedVisibility) return
    await delay(100)
  }
  throw new Error(`Electron window visibility did not become ${expectedVisibility}: ${urlSuffix}`)
}

async function waitForStableRegistry(page, label) {
  const started = performance.now()
  let previous
  let stableSamples = 0
  while (performance.now() - started < stableTimeoutMs) {
    const current = await readRegistrySnapshot(page)
    const comparable = JSON.stringify(current)
    if (comparable === previous) stableSamples += 1
    else stableSamples = 0
    if (stableSamples >= stableSamplesRequired) return current
    previous = comparable
    await delay(sampleIntervalMs)
  }
  throw new Error(`Renderer registry did not settle during ${label}`)
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
      require('node:child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } else {
      child.kill('SIGKILL')
    }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2_000)])
  }
  if (!hasExited()) throw new Error(`Measured Electron process ${child.pid} did not exit`)
  return outcome
}

function summarizePlateau(scopeVisits) {
  const firstFive = scopeVisits.slice(0, 5)
  const lastFive = scopeVisits.slice(-5)
  const maxOf = (visits, key) => Math.max(...visits.map(visit => visit[key]))
  const minOf = (visits, key) => Math.min(...visits.map(visit => visit[key]))
  const lastFiveNodeSpread = maxOf(lastFive, 'registryNodeCount') - minOf(lastFive, 'registryNodeCount')
  const lastFiveQuerySpread = maxOf(lastFive, 'queryMemberCount') - minOf(lastFive, 'queryMemberCount')
  return {
    firstFiveMaxRegistryNodes: maxOf(firstFive, 'registryNodeCount'),
    lastFiveMaxRegistryNodes: maxOf(lastFive, 'registryNodeCount'),
    lastFiveRegistryNodeSpread: lastFiveNodeSpread,
    firstFiveMaxQueryMembers: maxOf(firstFive, 'queryMemberCount'),
    lastFiveMaxQueryMembers: maxOf(lastFive, 'queryMemberCount'),
    lastFiveQueryMemberSpread: lastFiveQuerySpread,
    bounded: lastFiveNodeSpread <= 2 && lastFiveQuerySpread <= 2,
  }
}

function summarizeMainInstrumentation(instrumentation) {
  const summarizeBounds = bounds => {
    const maximumByChannel = bounds.maximum
    const values = Object.values(maximumByChannel)
    return {
      channelsObserved: values.length,
      maximumOnOneChannel: values.length === 0 ? 0 : Math.max(...values),
      sumOfPerChannelHighWatermarks: values.reduce((total, value) => total + value, 0),
    }
  }

  const ipcBoundsByScenario = Object.fromEntries(
    Object.entries(instrumentation.ipcBoundsByScenario).map(([scenario, bounds]) => [
      scenario,
      {
        listeners: summarizeBounds(bounds.listeners),
        handlers: summarizeBounds(bounds.handlers),
      },
    ]),
  )
  return {
    messagePortHook: {
      ...instrumentation.messagePortHook,
      measurementCloseListenersExcludedPerPort: 1,
    },
    observedWorkerCount: instrumentation.observedWorkerCount,
    observedWorkerExitCount: instrumentation.observedWorkerExitCount,
    observedWorkerCountByScenario: instrumentation.observedWorkerCountByScenario,
    observedWorkerExitCountByScenario: instrumentation.observedWorkerExitCountByScenario,
    workerRequestsByScenario: instrumentation.workerRequestsByScenario,
    rpcConnectAttemptsByScenario: instrumentation.rpcConnectAttemptsByScenario,
    bridgeRequestsByScenario: instrumentation.bridgeRequestsByScenario,
    observedNativeRpcPortCount: instrumentation.nativeRpcPortCount,
    closedNativeRpcPortCount: instrumentation.closedNativeRpcPortCount,
    activeNativeRpcPortCount: instrumentation.activeNativeRpcPortCount,
    maximumActiveNativeRpcPortCount: instrumentation.maximumActiveNativeRpcPortCount,
    nativeRpcPortsOpenedByScenario: instrumentation.nativeRpcPortsOpenedByScenario,
    nativeRpcPortsClosedByScenario: instrumentation.nativeRpcPortsClosedByScenario,
    nativeRpcPortListenerBoundsByScenario: instrumentation.nativeRpcPortListenerBoundsByScenario,
    ipcListenerBounds: summarizeBounds(instrumentation.ipcListeners),
    ipcHandlerBounds: summarizeBounds(instrumentation.ipcHandlers),
    ipcBoundsByScenario,
    nativeWindowEventTrace: instrumentation.nativeWindowEventTrace,
  }
}

async function main() {
  const gitDir = path.resolve(
    root,
    require('node:child_process')
      .execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' })
      .trim(),
  )
  const artifactDir = path.join(gitDir, `renderer-state-probe-${process.pid}`)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-renderer-state-'))
  const scenarioFile = path.join(profile, 'renderer-measurement-scenario.txt')
  const mainInstrumentationFile = path.join(profile, 'renderer-measurement-main.json')

  let app
  let appStopped = false
  let closeOutcome
  let failure
  const sectionSnapshots = []
  const scopeVisits = []
  const windowRegistrySnapshots = []
  const nativeWindowInventorySnapshots = []
  const report = {
    artifact: 'temporary .git renderer build with test-only Vite transform; not the unmodified startup measurement',
    phase: 'build',
    visitedSections: sections.map(([label]) => label),
    sectionSnapshots,
    scopeVisitCount,
    scopeVisits,
    orbPanelCycles: 3,
    windowRegistrySnapshots,
    nativeWindowInventorySnapshots,
    mainInstrumentation: 'collected after app shutdown',
    listenerCoverage:
      'ipcMain listeners sampled every 100 ms and on report writes; synchronous handler and main-side MessagePortMain listener counts; port counts exclude the measurement close observer',
    orbCycles: 'three actual main-window close and panel See overview cycles',
    dataRecorded:
      'period names, AtomRpc query tags and counts, registry node counts; no request arguments or query payloads',
  }
  try {
    const fixture = prepareProviderFixture(profile)
    fs.writeFileSync(scenarioFile, 'boot', 'utf8')
    const rendererDir = await buildArtifact(artifactDir)
    report.rendererAssetBytes = fs.readdirSync(rendererDir, { recursive: true }).reduce((total, entry) => {
      const file = path.join(rendererDir, entry)
      return fs.existsSync(file) && fs.statSync(file).isFile() ? total + fs.statSync(file).size : total
    }, 0)
    const appDir = artifactDir
    const started = performance.now()
    report.phase = 'launch'
    app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        path.join(root, 'scripts/probes/measure-renderer-main.cjs'),
        `--user-data-dir=${profile}`,
      ],
      cwd: appDir,
      env: {
        ...fixture.env,
        WATCHTOWER_MEASURE_APP_DIR: appDir,
        WATCHTOWER_MEASURE_SCENARIO_FILE: scenarioFile,
        WATCHTOWER_MEASURE_REPORT_FILE: mainInstrumentationFile,
      },
      timeout: 60_000,
    })

    const page = await app.firstWindow({ timeout: 60_000 })
    const pageErrors = []
    const disposeErrors = []
    let disposing = false
    const trackPageErrors = pageToTrack => {
      pageToTrack.on('pageerror', error => (disposing ? disposeErrors : pageErrors).push(error.message))
    }
    trackPageErrors(page)
    await page.waitForFunction(
      () => globalThis.document.querySelector('#root')?.firstElementChild !== null,
      undefined,
      { timeout: 60_000 },
    )
    await page.getByRole('button', { name: 'Skip', exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await page.getByRole('button', { name: 'Skip', exact: true }).click()

    report.phase = 'section-visits'
    for (const [label, accessibleName] of sections) {
      fs.writeFileSync(scenarioFile, `section:${label}`, 'utf8')
      const button = page.getByRole('button', { name: accessibleName, exact: true })
      await button.click()
      await page.waitForFunction(
        name =>
          Array.from(globalThis.document.querySelectorAll('button')).some(
            button => button.textContent?.trim() === name && button.hasAttribute('data-active'),
          ),
        accessibleName,
        { timeout: 10_000 },
      )
      await delay(500)
      sectionSnapshots.push({ section: label, ...(await waitForStableRegistry(page, `section ${label}`)) })
    }

    report.phase = 'scope-visits'
    for (let index = 0; index < scopeVisitCount; index += 1) {
      const period = periods[index % periods.length]
      fs.writeFileSync(scenarioFile, `scope:${index + 1}`, 'utf8')
      await page.evaluate(nextPeriod => globalThis.__watchtowerRendererStateProbe.setPeriod(nextPeriod), period)
      await page.waitForFunction(
        nextPeriod => globalThis.__watchtowerRendererStateProbe.period() === nextPeriod,
        period,
        {
          timeout: 10_000,
        },
      )
      const snapshot = await waitForStableRegistry(page, `scope visit ${index + 1}`)
      scopeVisits.push({ visit: index + 1, period, ...snapshot })
    }

    report.phase = 'orb-panel-cycles'
    let orbPage
    let panelPage
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      fs.writeFileSync(scenarioFile, `orb-cycle:${cycle}:close-main`, 'utf8')
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find(window => window.webContents.getURL().endsWith('/index.html'))
          ?.close(),
      )
      orbPage ??= await waitForWindowPage(app, '/orb.html')
      panelPage ??= await waitForWindowPage(app, '/orb-panel.html')
      if (cycle === 1) {
        trackPageErrors(orbPage)
        trackPageErrors(panelPage)
      }

      const panelVisible = await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find(window => window.webContents.getURL().endsWith('/orb-panel.html'))
            ?.isVisible() ?? false,
      )
      if (!panelVisible) {
        nativeWindowInventorySnapshots.push({
          cycle,
          phase: 'before-panel-open',
          windows: await readNativeWindowInventory(app),
          panelToggle: await readOrbPanelToggle(orbPage),
        })
        const showPanel = orbPage.getByRole('button', { name: 'Show Watchtower panel', exact: true })
        await showPanel.waitFor({ state: 'visible', timeout: 10_000 })
        await showPanel.click()
        const foldPanel = orbPage.getByRole('button', { name: 'Fold Watchtower panel', exact: true })
        try {
          await foldPanel.waitFor({ state: 'visible', timeout: 30_000 })
        } catch (error) {
          nativeWindowInventorySnapshots.push({
            cycle,
            phase: 'panel-toggle-timeout',
            windows: await readNativeWindowInventory(app),
            panelToggle: await readOrbPanelToggle(orbPage),
          })
          throw error
        }
        try {
          await waitForNativeWindowVisibility(app, '/orb-panel.html', true)
        } catch (error) {
          nativeWindowInventorySnapshots.push({
            cycle,
            phase: 'panel-open-timeout',
            windows: await readNativeWindowInventory(app),
            panelToggle: await readOrbPanelToggle(orbPage),
          })
          throw error
        }
      }
      await panelPage.getByRole('button', { name: /^See overview/ }).waitFor({ state: 'visible', timeout: 30_000 })

      const windows = [
        { name: 'main', page },
        { name: 'orb', page: orbPage },
        { name: 'panel', page: panelPage },
      ]
      const registryCounts = {}
      for (const entry of windows) {
        registryCounts[entry.name] = await readRegistrySnapshot(entry.page)
      }
      windowRegistrySnapshots.push({ cycle, phase: 'background', registryCounts })
      nativeWindowInventorySnapshots.push({ cycle, phase: 'background', windows: await readNativeWindowInventory(app) })

      fs.writeFileSync(scenarioFile, `orb-cycle:${cycle}:see-overview`, 'utf8')
      await panelPage.getByRole('button', { name: /^See overview/ }).click()
      await waitForNativeWindowVisibility(app, '/index.html', true)
      await page.getByText('Total spend', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      const returnedRegistryCounts = {}
      for (const entry of windows) {
        returnedRegistryCounts[entry.name] = await readRegistrySnapshot(entry.page)
      }
      windowRegistrySnapshots.push({ cycle, phase: 'returned', registryCounts: returnedRegistryCounts })
      nativeWindowInventorySnapshots.push({ cycle, phase: 'returned', windows: await readNativeWindowInventory(app) })
    }

    fs.writeFileSync(scenarioFile, 'dispose', 'utf8')
    disposing = true
    const disposedRegistryNodeCount = await page.evaluate(() => globalThis.__watchtowerRendererStateProbe.dispose())
    await delay(100)
    const elapsedMs = performance.now() - started
    const peak = await page.evaluate(() => globalThis.__watchtowerRendererStateProbe.metrics())
    const windowSnapshots = windowRegistrySnapshots.flatMap(snapshot => Object.values(snapshot.registryCounts))
    const peakAcrossObservedWindows = {
      registryNodeCount: Math.max(...windowSnapshots.map(snapshot => snapshot.observedPeak.registryNodeCount)),
      atomRpcSerializableMemberCount: Math.max(
        ...windowSnapshots.map(snapshot => snapshot.observedPeak.atomRpcSerializableMemberCount),
      ),
      queryMemberCount: Math.max(...windowSnapshots.map(snapshot => snapshot.observedPeak.queryMemberCount)),
    }
    const settled = scopeVisits.at(-1)
    Object.assign(report, {
      phase: 'complete',
      elapsedMs: Number(elapsedMs.toFixed(1)),
      peak,
      peakAcrossObservedWindows,
      settled: {
        registryNodeCount: settled.registryNodeCount,
        atomRpcSerializableMemberCount: settled.atomRpcSerializableMemberCount,
        queryMemberCount: settled.queryMemberCount,
      },
      plateau: summarizePlateau(scopeVisits),
      disposedRegistryNodeCount,
      registryDisposalPassed: disposedRegistryNodeCount === 0,
      pageErrors,
      disposeErrors,
      disposalMethod: 'test-only direct owner.dispose while the React tree remains mounted for registry inspection',
    })
  } catch (error) {
    failure = error
    report.failure = { message: error.message, stack: error.stack }
    process.stdout.write(`${JSON.stringify({ partial: true, ...report }, null, 2)}\n`)
  } finally {
    try {
      if (app) {
        try {
          closeOutcome = await closeApp(app)
          appStopped = true
        } catch (error) {
          console.error(`[renderer state probe] app shutdown failed: ${String(error)}`)
          if (!failure) failure = error
        }
      } else {
        appStopped = true
      }
    } finally {
      if (failure) report.failure = { message: failure.message, stack: failure.stack }
      report.closeOutcome = closeOutcome
      if (report && fs.existsSync(mainInstrumentationFile)) {
        try {
          const instrumentation = JSON.parse(fs.readFileSync(mainInstrumentationFile, 'utf8'))
          report.mainInstrumentation = summarizeMainInstrumentation(instrumentation)
        } catch (error) {
          report.mainInstrumentation = `unreadable: ${String(error)}`
        }
      } else if (report) {
        report.mainInstrumentation = 'missing; no main-process instrumentation report was written'
      }
      if (appStopped) {
        for (const [target, parent, prefix] of [
          [artifactDir, gitDir, 'renderer-state-probe-'],
          [profile, os.tmpdir(), 'watchtower-renderer-state-'],
        ]) {
          try {
            removeGeneratedDirectory(target, parent, prefix)
          } catch (error) {
            if (!failure) failure = error
            console.error(`[renderer state probe] failed to remove ${target}: ${String(error)}`)
          }
        }
      } else console.error('[renderer state probe] retained temporary files because Electron may still be using them')
    }
  }

  if (failure) report.failure = { message: failure.message, stack: failure.stack }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (failure || !report.registryDisposalPassed || !report.plateau.bounded || report.pageErrors.length > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
