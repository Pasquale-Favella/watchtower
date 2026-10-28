const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareProviderFixture } = require('./fixtures/provider.cjs')
const { createRequire } = require('node:module')
const fromRepo = createRequire(path.join(process.cwd(), 'package.json'))
const { _electron: electron, expect } = fromRepo('@playwright/test')
const { Client } = fromRepo('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport, getDefaultEnvironment } = fromRepo('@modelcontextprotocol/sdk/client/stdio.js')

function parseOptions(args) {
  const options = { executablePath: null, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--executable') {
      options.executablePath = args[++index]
      if (!options.executablePath) throw new Error('--executable requires a path')
    } else if (arg.startsWith('--executable=')) {
      options.executablePath = arg.slice('--executable='.length)
      if (!options.executablePath) throw new Error('--executable requires a path')
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return options
}

function defaultExecutablePath(platform) {
  const layouts = {
    win32: path.join('dist', 'win-unpacked', 'Watchtower.exe'),
    darwin: path.join('dist', 'mac-universal', 'Watchtower.app', 'Contents', 'MacOS', 'Watchtower'),
    linux: path.join('dist', 'linux-unpacked', 'watchtower-desktop'),
  }
  const layout = layouts[platform]
  if (!layout) throw new Error(`Unsupported packaged verification platform: ${platform}`)
  return path.resolve(layout)
}

function resolveExecutablePath(options) {
  const executablePath = path.resolve(options.executablePath ?? defaultExecutablePath(process.platform))
  assert.ok(fs.existsSync(executablePath), `Packaged executable does not exist: ${executablePath}`)
  return executablePath
}

function ledgerMcpEntry(resourcesPath) {
  const archive = path.join(resourcesPath, 'app.asar')
  assert.ok(fs.statSync(archive).isFile(), `Packaged ASAR archive does not exist: ${archive}`)
  return path.join(archive, 'out', 'main', 'ledger-mcp.js')
}

async function checkMcp(executablePath, entryPath, dbPath) {
  const transport = new StdioClientTransport({
    command: executablePath,
    args: [entryPath, '--ledger-mcp'],
    env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1', WATCHTOWER_LEDGER_MCP: JSON.stringify({ dbPath }) },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'watchtower-packaged-gate', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'ledger_calls',
      'ledger_models',
      'ledger_overview',
      'ledger_scope',
      'ledger_sessions',
      'ledger_skills',
    ])
    for (const tool of tools.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      const result = await client.callTool({ name: tool.name })
      assert.notEqual(result.isError, true)
      assert.equal(result.content[0].type, 'text')
      JSON.parse(result.content[0].text)
    }
    assert.equal(
      (await client.callTool({ name: 'ledger_scope', arguments: { scope: { period: 'invalid' } } })).isError,
      true,
    )
    assert.equal((await client.callTool({ name: 'unknown' })).isError, true)
    const resources = await client.listResources()
    assert.equal(resources.resources.length, 3)
    const scopeResource = await client.readResource({ uri: 'ledger://scope' })
    assert.equal(scopeResource.contents[0].mimeType, 'text/markdown')
    assert.ok(scopeResource.contents[0].text.startsWith('# Watchtower data window'))
    const overviewResource = await client.readResource({ uri: 'ledger://overview' })
    assert.equal(overviewResource.contents[0].mimeType, 'application/json')
    JSON.parse(overviewResource.contents[0].text)
    const schemaResource = await client.readResource({ uri: 'ledger://schema' })
    assert.equal(schemaResource.contents[0].mimeType, 'text/markdown')
    assert.ok(schemaResource.contents[0].text.startsWith('# Watchtower ledger schema'))
    const prompts = await client.listPrompts()
    assert.equal(prompts.prompts.length, 1)
    assert.ok((await client.getPrompt({ name: prompts.prompts[0].name })).messages.length > 0)
    console.log(
      'Packaged MCP stdio passed: six tools, generated metadata, invalid/unknown tool results, resource and prompt.',
    )
  } finally {
    try {
      await client.close()
    } finally {
      await transport.close()
      assert.equal(transport.pid, null)
    }
  }
}

async function checkMcpHttp(executablePath, entryPath, dbPath) {
  const { spawn } = require('node:child_process')
  const { once } = require('node:events')
  const { createInterface } = require('node:readline')
  const { randomUUID } = require('node:crypto')
  const { StreamableHTTPClientTransport } = fromRepo('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const token = randomUUID()
  const child = spawn(executablePath, [entryPath, '--ledger-mcp-http'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WATCHTOWER_LEDGER_MCP: JSON.stringify({ dbPath, token }) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = once(child, 'exit')
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(chunk.toString()))
  const lines = createInterface({ input: child.stdout })
  const client = new Client({ name: 'watchtower-packaged-http-gate', version: '1.0.0' })
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Packaged HTTP child did not announce READY')), 10000)
      child.once('error', reject)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(Error('Packaged HTTP child exited before READY: ' + stderr.join('')))
      })
      lines.on('line', line => {
        if (line.startsWith('READY ')) {
          clearTimeout(timer)
          resolve(JSON.parse(line.slice(6)).port)
        }
      })
    })
    const url = new URL('http://127.0.0.1:' + port + '/mcp')
    const headers = { authorization: 'Bearer ' + token }
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
      401,
    )
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
    assert.equal((await client.listTools()).tools.length, 6)
    for (const name of [
      'ledger_scope',
      'ledger_overview',
      'ledger_sessions',
      'ledger_models',
      'ledger_skills',
      'ledger_calls',
    ]) {
      const result = await client.callTool({ name })
      assert.notEqual(result.isError, true)
      JSON.parse(result.content[0].text)
    }
    assert.equal((await client.listResources()).resources.length, 3)
    for (const uri of ['ledger://scope', 'ledger://overview', 'ledger://schema']) {
      assert.equal((await client.readResource({ uri })).contents.length, 1)
    }
    assert.ok((await client.getPrompt({ name: 'coach-orient' })).messages.length > 0)
    const before = JSON.parse((await client.callTool({ name: 'ledger_scope' })).content[0].text)
    const after = JSON.parse((await client.callTool({ name: 'ledger_scope' })).content[0].text)
    assert.equal(after.calls, before.calls)
    assert.equal(after.sessions, before.sessions)
    console.log(
      'Packaged MCP HTTP passed: six tools, three resources, prompt, bearer rejection and runtime reuse across stateless requests.',
    )
  } finally {
    try {
      await client.close()
    } finally {
      lines.close()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
      assert.notEqual(child.pid, undefined)
    }
  }
}
async function installRendererRpcProbe(window) {
  await window.evaluate(async () => {
    const bridge = window.api.rpcV1
    const connection = await bridge.connect()
    if (connection._tag !== 'Connected') throw new Error('Packaged RPC connection failed')
    let sequence = 0
    let disposed = false
    const prefix = `watchtower-packaged-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const call = (tag, payload = null) =>
      new Promise((resolve, reject) => {
        if (disposed) return reject(new Error('Packaged RPC probe is disposed'))
        const id = `${prefix}-${++sequence}`
        let settled = false
        let unsubscribe = () => {}
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          unsubscribe()
          if (error) reject(error)
          else resolve(value)
        }
        const timeout = setTimeout(() => finish(new Error(`Packaged RPC timed out: ${tag}`)), 10000)
        unsubscribe = bridge.onMessage(raw => {
          let frame
          try {
            if (typeof raw !== 'string') throw new Error('Invalid RPC frame')
            frame = JSON.parse(raw)
          } catch {
            return finish(new Error('Malformed packaged RPC response'))
          }
          if (!frame || frame.requestId !== id) return
          if (frame._tag === 'Defect') return finish(new Error('Packaged RPC server failure'))
          if (frame._tag !== 'Exit' || !frame.exit || typeof frame.exit !== 'object')
            return finish(new Error('Malformed packaged RPC response'))
          if (frame.exit._tag === 'Success') {
            if (!Object.prototype.hasOwnProperty.call(frame.exit, 'value'))
              return finish(new Error('Malformed packaged RPC success'))
            return finish(undefined, frame.exit.value)
          }
          if (frame.exit._tag !== 'Failure' || !Array.isArray(frame.exit.cause) || frame.exit.cause.length === 0)
            return finish(new Error('Malformed packaged RPC failure'))
          const failure = frame.exit.cause.find(item => item && item._tag === 'Fail' && item.error)
          if (!failure) return finish(new Error('Packaged RPC operation failed'))
          if (
            typeof failure.error !== 'object' ||
            typeof failure.error._tag !== 'string' ||
            typeof failure.error.code !== 'string' ||
            typeof failure.error.message !== 'string'
          )
            return finish(new Error('Malformed packaged RPC error'))
          const error = new Error('Packaged RPC operation failed')
          error.rpcError = failure.error
          finish(error)
        }, connection.generation)
        bridge
          .send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }), connection.generation)
          .catch(() => finish(new Error(`Packaged RPC send failed: ${tag}`)))
      })
    window.rpcProbe = {
      call,
      dispose: () => {
        if (disposed) return
        disposed = true
        bridge.disconnect(connection.generation)
      },
    }
  })
}

async function checkRendererRpc(window) {
  const result = await window.evaluate(async () => {
    const status = await window.rpcProbe.call('store:status')
    const name = 'watchtower-packaged-rpc-model'
    const receipt = await window.rpcProbe.call('models:setPrice', {
      model: name,
      inputPricePerMillion: 0,
      outputPricePerMillion: 2,
    })
    const prices = await window.rpcProbe.call('models:getPriceOverrides')
    await window.rpcProbe.call('models:removePriceOverride', { model: name })
    return { status, receipt, price: prices.find(price => price.model === name) }
  })
  assert.equal(result.status.scanned, true)
  assert.equal(result.receipt.ok, true)
  assert.ok(Number.isInteger(result.receipt.configRevision))
  assert.deepEqual(result.price, {
    model: 'watchtower-packaged-rpc-model',
    inputPricePerMillion: 0,
    outputPricePerMillion: 2,
  })
  console.log('Packaged sandbox RPC query and admitted configuration write passed over MessagePort.')
}

function basenameFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    return segments.at(-1) ?? 'unloaded'
  } catch {
    return 'unloaded'
  }
}

async function inspectNativeWindows(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map(win => {
        const url = win.webContents.getURL()
        let basename = 'unloaded'
        try {
          basename = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? 'unloaded'
        } catch {
          // Keep diagnostics to an allowlisted basename even for non-URL pages.
        }
        const preferences = win.webContents.getLastWebPreferences()
        return {
          basename,
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          webContentsId: win.webContents.id,
          security: {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
          },
        }
      })
      .sort((left, right) => left.basename.localeCompare(right.basename)),
  )
}

async function installNativeWindowDiagnostics(app) {
  await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    const key = '__watchtowerVerifyNativeWindowDiagnostics'
    if (globalThis[key]) return

    const trace = []
    const tracked = new WeakSet()
    const basename = win => {
      try {
        return new URL(win.webContents.getURL()).pathname.split('/').filter(Boolean).at(-1) ?? 'unloaded'
      } catch {
        return 'unloaded'
      }
    }
    const record = (win, event) => {
      let visible = false
      let minimized = false
      let destroyed = true
      try {
        destroyed = win.isDestroyed()
        if (!destroyed) {
          visible = win.isVisible()
          minimized = win.isMinimized()
        }
      } catch {
        // A close transition can invalidate a BrowserWindow between checks.
      }
      trace.push({
        elapsedMs: Math.round(performance.now()),
        event,
        basename: basename(win),
        visible,
        minimized,
        destroyed,
      })
      if (trace.length > 100) trace.shift()
    }
    const track = win => {
      if (tracked.has(win)) return
      tracked.add(win)
      for (const event of [
        'show',
        'hide',
        'focus',
        'blur',
        'minimize',
        'restore',
        'close',
        'closed',
        'ready-to-show',
      ]) {
        win.on(event, () => record(win, event))
      }
      record(win, 'attached')
    }

    for (const win of BrowserWindow.getAllWindows()) track(win)
    electronApp.on('browser-window-created', (_event, win) => track(win))
    globalThis[key] = trace
  })
}

async function nativeWindowDiagnostics(app) {
  return app.evaluate(() => globalThis.__watchtowerVerifyNativeWindowDiagnostics ?? [])
}

async function expectNativeVisibility(app, expect, basename, visible, phase) {
  const isVisible = async () =>
    (await inspectNativeWindows(app)).find(surface => surface.basename === basename)?.visible ?? false
  try {
    await expect.poll(isVisible).toBe(visible)
  } catch (cause) {
    const [inventory, events] = await Promise.all([inspectNativeWindows(app), nativeWindowDiagnostics(app)])
    throw new Error(
      `Packaged native visibility timed out during ${phase}: ${basename} expected visible=${visible}; ` +
        JSON.stringify({ inventory, events }),
      { cause },
    )
  }
}

function assertPackagedSurfaces(inventory, phase) {
  const expected = ['index.html', 'orb-panel.html', 'orb.html']
  const roles = inventory.map(surface => surface.basename)
  const safeInventory = inventory.map(({ basename, visible, minimized }) => ({ basename, visible, minimized }))
  assert.deepEqual(
    roles,
    expected,
    `${phase}: expected exactly one app, beacon, and panel window; ${JSON.stringify(safeInventory)}`,
  )
  for (const surface of inventory) {
    assert.deepEqual(
      surface.security,
      { sandbox: true, contextIsolation: true, nodeIntegration: false },
      `${phase}: unsafe web preferences for ${surface.basename}; ${JSON.stringify(safeInventory)}`,
    )
  }
}

async function pageForSurface(app, basename, expect) {
  await expect.poll(() => app.windows().some(page => basenameFromUrl(page.url()) === basename)).toBe(true)
  const page = app.windows().find(candidate => basenameFromUrl(candidate.url()) === basename)
  if (!page) throw new Error(`Packaged ${basename} page disappeared after navigation`)
  return page
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/verify-packaged.cjs [--executable <path>]')
    return
  }
  const executablePath = resolveExecutablePath(options)
  const profilePrefix = 'watchtower-packaged-'
  const tempRoot = fs.realpathSync(os.tmpdir())
  const profile = fs.mkdtempSync(path.join(tempRoot, profilePrefix))
  try {
    const providerFixture = prepareProviderFixture(profile)
    const args = [`--user-data-dir=${profile}`]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    const app = await electron.launch({ executablePath, args, env: providerFixture.env, timeout: 60000 })
    try {
      const pageErrors = []
      const capturedPages = new WeakSet()
      const capturePageErrors = page => {
        if (capturedPages.has(page)) return
        capturedPages.add(page)
        page.on('pageerror', error =>
          pageErrors.push({ basename: basenameFromUrl(page.url()), message: error.message }),
        )
      }
      app.on('window', capturePageErrors)
      for (const page of app.windows()) capturePageErrors(page)
      const window = await app.firstWindow({ timeout: 60000 })
      capturePageErrors(window)
      await expect(window).toHaveTitle(/Watchtower/)
      await installRendererRpcProbe(window)
      await window.evaluate(() => window.rpcProbe.call('cadence:set', { value: 'manual' }))
      const skip = window.getByRole('button', { name: 'Skip' })
      const retry = window.getByRole('button', { name: 'Retry' })
      await expect
        .poll(async () => (await retry.isVisible()) || (await skip.isVisible()), { timeout: 240000 })
        .toBe(true)
      assert.equal(await retry.isVisible(), false)
      await skip.click()
      await expect(skip).toBeHidden()
      await checkRendererRpc(window)
      await window.getByRole('button', { name: 'Sessions', exact: true }).click()
      await expect(
        window
          .getByRole('textbox', { name: 'Search sessions' })
          .or(window.getByText('No sessions in this range yet.', { exact: true }))
          .first(),
      ).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Models', exact: true }).click()
      await expect(window.getByRole('tab', { name: 'By model' })).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Overview', exact: true }).click()
      await expect(window.getByText('Total spend', { exact: true })).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Spend', exact: true }).click()
      await expect(window.getByText('Daily spend by model', { exact: true })).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Compare', exact: true }).click()
      await expect(
        window
          .getByLabel('Models being compared')
          .or(window.getByText('Need at least two models with usage in this range to compare.', { exact: true }))
          .first(),
      ).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Pull requests', exact: true }).click()
      await expect(window.getByText('Pull request spend', { exact: true })).toBeVisible({ timeout: 30000 })
      await window.getByRole('button', { name: 'Optimize', exact: true }).click()
      await expect(window.getByText('Setup health', { exact: true })).toBeVisible({ timeout: 30000 })
      await window.getByRole('tab', { name: 'Outcomes', exact: true }).click()
      await expect(window.getByRole('heading', { name: 'Delivery evidence', exact: true })).toBeVisible({
        timeout: 30000,
      })
      await window.getByRole('tab', { name: 'Reverts', exact: true }).click()
      await expect(window.getByRole('heading', { name: 'Sessions with reverted changes' })).toBeVisible({
        timeout: 30000,
      })
      await window.getByRole('button', { name: 'Coach & Skills', exact: true }).click()
      await expect(window.getByPlaceholder('Ask anything or say “craft a skill for …”')).toBeVisible({ timeout: 30000 })
      const migratedPayloads = await window.evaluate(async () => {
        const scope = { period: 'lifetime' }
        return {
          optimize: await window.rpcProbe.call('optimize:view', { scope }),
          yield: await window.rpcProbe.call('optimize:yield', { scope }),
          skills: await window.rpcProbe.call('skills:view', { scope }),
        }
      })
      assert.ok(migratedPayloads.optimize && Array.isArray(migratedPayloads.optimize.findings))
      assert.ok(migratedPayloads.yield && Array.isArray(migratedPayloads.yield.details))
      assert.ok(migratedPayloads.skills && Array.isArray(migratedPayloads.skills.drafts))
      const sessionPayloads = await window.evaluate(async () => {
        const projects = await window.rpcProbe.call('store:projects')
        const sessions = await window.rpcProbe.call('store:sessions', { filter: {} })
        const detail = sessions.length
          ? await window.rpcProbe.call('store:session', { sessionId: sessions[0].sessionId, sourceId: 1 })
          : null
        const term = detail?.turns
          .find(turn => turn.userMessage.trim())
          ?.userMessage.trim()
          .slice(0, 24)
        return {
          projects,
          sessions,
          detail,
          term,
          hits: term ? await window.rpcProbe.call('store:search', { query: term }) : [],
          missing: await window.rpcProbe.call('store:session', { sessionId: 'watchtower-packaged-missing-session' }),
          blank: await window.rpcProbe.call('store:search', { query: '  \t ' }),
        }
      })
      assert.ok(Array.isArray(sessionPayloads.projects) && sessionPayloads.projects.length > 0)
      assert.ok(Array.isArray(sessionPayloads.sessions) && sessionPayloads.sessions.length > 0)
      assert.equal(sessionPayloads.detail?.sessionId, sessionPayloads.sessions[0].sessionId)
      assert.ok(sessionPayloads.detail.turns.length > 0)
      assert.ok(sessionPayloads.term)
      assert.ok(sessionPayloads.hits.length > 0)
      assert.ok(
        sessionPayloads.hits.every(hit => hit.snippet.toLowerCase().includes(sessionPayloads.term.toLowerCase())),
      )
      assert.equal(sessionPayloads.missing, null)
      assert.deepEqual(sessionPayloads.blank, [])
      console.log(
        'Packaged project/session rows, targeted detail, positive search, missing detail and blank search RPC passed.',
      )
      const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      assert.equal(path.resolve(userData), path.resolve(profile))
      const resourcesPath = await app.evaluate(() => process.resourcesPath)
      const runtimeExecutablePath = await app.evaluate(() => process.execPath)
      assert.ok(fs.statSync(runtimeExecutablePath).isFile(), 'Electron runtime executable is missing')
      const entryPath = ledgerMcpEntry(resourcesPath)
      const exportFolder = path.join(profile, 'exports', 'usage')
      const jsonPath = path.join(profile, 'exports', 'usage.json')
      const exports = await window.evaluate(
        async ({ csv, json }) => ({
          csv: await window.rpcProbe.call('export', { format: 'csv', destination: csv }),
          json: await window.rpcProbe.call('export', { format: 'json', destination: json }),
          harnesses: await window.rpcProbe.call('coach:harnesses'),
        }),
        { csv: exportFolder, json: jsonPath },
      )
      assert.deepEqual(exports.csv, { ok: true, path: exportFolder })
      assert.deepEqual(exports.json, { ok: true, path: jsonPath })
      const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      assert.equal(report.schema, 'watchtower.export.v1')
      assert.ok(Array.isArray(report.records) && report.records.length > 0)
      assert.ok(
        fs.readFileSync(path.join(exportFolder, 'README.txt'), 'utf8').includes(`Currency:  ${report.currency.code}`),
      )
      assert.ok(fs.existsSync(path.join(exportFolder, '.watchtower-export')))
      assert.equal(fs.readdirSync(exportFolder).length, 11)
      assert.ok(Array.isArray(exports.harnesses))
      const config = await window.evaluate(async () => {
        const name = 'watchtower-wave20-gate-model'
        const call = window.rpcProbe.call
        const cadence = await call('cadence:get')
        const manual = await call('cadence:set', { value: 'manual' })
        const restoredCadence = await call('cadence:set', { value: cadence })
        const aliasReceipt = await call('models:addAlias', { model: ` ${name} `, aliasOf: ' target-model ' })
        const aliases = await call('models:getAliases')
        const priceReceipt = await call('models:setPrice', {
          model: ` ${name} `,
          inputPricePerMillion: 0,
          outputPricePerMillion: 2,
        })
        const prices = await call('models:getPriceOverrides')
        const removeAliasReceipt = await call('models:removeAlias', { model: ` ${name} ` })
        const removePriceReceipt = await call('models:removePriceOverride', { model: ` ${name} ` })
        const remainingAliases = await call('models:getAliases')
        const remainingPrices = await call('models:getPriceOverrides')
        const dismissal = await call('skills:dismiss', { source: 'bash', name: 'wave20-gate', reason: 'fixture' })
        const status = await call('store:status')
        const startup = await call('ledger-mcp:startup:set', { mode: 'on-demand' })
        const invalid = await call('models:setPrice', {
          model: name,
          inputPricePerMillion: -1,
          outputPricePerMillion: 0,
        }).then(
          () => ({ accepted: true }),
          error => ({ accepted: false, error: error.rpcError }),
        )
        return {
          name,
          manual,
          cadence,
          restoredCadence,
          aliasReceipt,
          priceReceipt,
          removeAliasReceipt,
          removePriceReceipt,
          aliases,
          prices,
          remainingAliases,
          remainingPrices,
          dismissal,
          status,
          startup,
          invalid,
        }
      })
      assert.equal(config.manual, 'manual')
      assert.equal(config.restoredCadence, config.cadence)
      for (const receipt of [
        config.aliasReceipt,
        config.priceReceipt,
        config.removeAliasReceipt,
        config.removePriceReceipt,
      ]) {
        assert.equal(receipt.ok, true)
        assert.ok(Number.isInteger(receipt.configRevision))
      }
      assert.ok(config.aliases.some(alias => alias.model === config.name && alias.aliasOf === 'target-model'))
      assert.ok(
        config.prices.some(
          price => price.model === config.name && price.inputPricePerMillion === 0 && price.outputPricePerMillion === 2,
        ),
      )
      assert.ok(!config.remainingAliases.some(alias => alias.model === config.name))
      assert.ok(!config.remainingPrices.some(price => price.model === config.name))
      assert.deepEqual(config.dismissal, { ok: true })
      assert.equal(config.status.scanned, true)
      assert.equal(config.startup.startupMode, 'on-demand')
      assert.equal(config.invalid.accepted, false)
      assert.deepEqual(config.invalid.error, {
        _tag: 'ConfigRpcError',
        code: 'command-failed',
        message: 'Configuration command failed',
      })
      console.log(
        'Packaged configuration ports passed: cadence, aliases and price CRUD, zero price, dismissal, startup, source status and failed validation.',
      )
      const inspection = await window.evaluate(async rows => {
        const harness = rows.find(row => row.kind === 'codex') ?? rows.find(row => row.kind === 'claude')
        if (!harness) return { skipped: true }
        const result = await window.rpcProbe.call('coach:inspect', { request: { kind: harness.kind } })
        return { kind: harness.kind, binaryPath: harness.binaryPath, result }
      }, exports.harnesses)
      assert.notEqual(inspection.skipped, true, 'Packaged Coach SDK inspection requires a detected bundled harness')
      assert.equal(typeof inspection.result.ok, 'boolean')
      if (!inspection.result.ok) {
        assert.equal(typeof inspection.result.error, 'string')
        assert.ok(inspection.result.error.length < 700)
        if (inspection.binaryPath) assert.ok(!inspection.result.error.includes(inspection.binaryPath))
        assert.ok(!inspection.result.error.includes('token='))
      }
      console.log(
        'Packaged Coach SDK inspection settled with bounded wire data:',
        inspection.kind,
        inspection.result.ok ? 'success' : 'expected failure',
      )
      const protectedFolder = path.join(profile, 'exports', 'protected')
      fs.mkdirSync(protectedFolder)
      const protectedFile = path.join(protectedFolder, 'keep.txt')
      fs.writeFileSync(protectedFile, 'untouched')
      const refused = await window.evaluate(
        async target => window.rpcProbe.call('export', { format: 'csv', destination: target }),
        protectedFolder,
      )
      assert.equal(refused.ok, false)
      assert.equal(typeof refused.error, 'string')
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'untouched')
      console.log(
        'Packaged export CSV/JSON, marker/schema/currency coherence, protected destination and main-owned harness RPC passed.',
      )
      await checkMcp(runtimeExecutablePath, entryPath, path.join(userData, 'ledger.db'))
      await checkMcpHttp(runtimeExecutablePath, entryPath, path.join(userData, 'ledger.db'))
      const cleared = await window.evaluate(async () => {
        const call = window.rpcProbe.call
        await call('cadence:set', { value: 'manual' })
        const selected = await call('currency:set', { code: 'EUR' })
        const cached = await call('currency:get')
        const invalid = await call('currency:set', { code: ' eur ' }).then(
          () => ({ accepted: true }),
          error => ({ accepted: false, error: error.rpcError }),
        )
        await call('currency:set', { code: 'USD' })
        const aliasReceipt = await call('models:addAlias', {
          model: 'wave20-clear-config',
          aliasOf: 'target-model',
        })
        const priceReceipt = await call('models:setPrice', {
          model: 'wave20-clear-config',
          inputPricePerMillion: 0,
          outputPricePerMillion: 2,
        })
        const info = await call('settings:clear')
        return {
          selected,
          cached,
          invalid,
          info,
          aliasReceipt,
          priceReceipt,
          currency: await call('currency:get'),
          cadence: await call('cadence:get'),
          aliases: await call('models:getAliases'),
          prices: await call('models:getPriceOverrides'),
          startup: await call('ledger-mcp:status'),
          status: await call('store:status'),
          projects: await call('store:projects'),
          sessions: await call('store:sessions', { filter: {} }),
        }
      })
      assert.equal(cleared.selected.code, 'EUR')
      assert.equal(cleared.cached.code, 'EUR')
      assert.equal(cleared.invalid.accepted, false)
      assert.deepEqual(cleared.invalid.error, {
        _tag: 'ConfigRpcError',
        code: 'command-failed',
        message: 'Configuration command failed',
      })
      assert.equal(path.resolve(cleared.info.settings.dataDir), path.resolve(profile))
      assert.ok(Number.isInteger(cleared.info.ledgerGeneration))
      for (const receipt of [cleared.aliasReceipt, cleared.priceReceipt]) {
        assert.equal(receipt.ok, true)
        assert.ok(Number.isInteger(receipt.configRevision))
      }
      assert.equal(cleared.cadence, 'manual')
      assert.deepEqual(cleared.currency, { code: 'USD', symbol: '$', rate: 1 })
      assert.ok(
        cleared.aliases.some(alias => alias.model === 'wave20-clear-config' && alias.aliasOf === 'target-model'),
      )
      assert.ok(cleared.prices.some(price => price.model === 'wave20-clear-config' && price.inputPricePerMillion === 0))
      assert.equal(cleared.startup.startupMode, 'on-demand')
      assert.equal(cleared.status.scanned, false)
      assert.deepEqual(cleared.projects, [])
      assert.deepEqual(cleared.sessions, [])
      console.log(
        'Packaged currency select/cache/validation and clear/reclaim RPC passed; facts cleared, config retained.',
      )

      // Exercise the packaged background shell with its actual windows. A
      // renderer `window.close()` would destroy the page; closing the native
      // BrowserWindow follows the app's hide-and-float lifecycle.
      await app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('index.html'))
        if (!main) throw new Error('Packaged main BrowserWindow is missing')
        if (main.isMinimized()) main.restore()
        main.show()
      })
      await expect
        .poll(async () => (await inspectNativeWindows(app)).find(surface => surface.basename === 'index.html')?.visible)
        .toBe(true)

      await installNativeWindowDiagnostics(app)

      const orbPagePromise = pageForSurface(app, 'orb.html', expect)
      const panelPagePromise = pageForSurface(app, 'orb-panel.html', expect)
      await app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('index.html'))
        if (!main) throw new Error('Packaged main BrowserWindow is missing before close')
        main.close()
      })
      const [orb, panel] = await Promise.all([orbPagePromise, panelPagePromise])
      await expectNativeVisibility(app, expect, 'index.html', false, 'main window close')
      const beaconButton = orb.getByRole('button', { name: /Watchtower panel/ })
      await expect(beaconButton).toBeVisible({ timeout: 30000 })
      await expect(panel.getByText('Spend over time', { exact: true })).toBeVisible({ timeout: 60000 })

      // The first-close peek can open between pointer-down and pointer-up.
      // Let that one-time lifecycle finish before testing a user toggle.
      await expect
        .poll(
          async () => (await inspectNativeWindows(app)).find(surface => surface.basename === 'orb-panel.html')?.visible,
          {
            timeout: 60000,
          },
        )
        .toBe(true)
      await expect(panel.getByText(/^Still watching in the background/)).toBeVisible()
      await expect
        .poll(
          async () => (await inspectNativeWindows(app)).find(surface => surface.basename === 'orb-panel.html')?.visible,
          {
            timeout: 15000,
          },
        )
        .toBe(false)
      await orb.getByRole('button', { name: 'Show Watchtower panel', exact: true }).click()
      await expectNativeVisibility(app, expect, 'orb-panel.html', true, 'beacon open')
      const backgroundInventory = await inspectNativeWindows(app)
      assertPackagedSurfaces(backgroundInventory, 'backgrounded')

      await panel.getByRole('button', { name: /^See overview/ }).click()
      await expectNativeVisibility(app, expect, 'index.html', true, 'See overview navigation')
      await expect(window.getByText('Total spend', { exact: true })).toBeVisible({ timeout: 30000 })
      await expectNativeVisibility(app, expect, 'orb.html', false, 'orb hide after See overview')
      const restoredInventory = await inspectNativeWindows(app)
      assertPackagedSurfaces(restoredInventory, 'restored')
      assert.deepEqual(
        restoredInventory.map(surface => [surface.basename, surface.webContentsId]),
        backgroundInventory.map(surface => [surface.basename, surface.webContentsId]),
        'the app, beacon, and panel BrowserWindows must be reused after panel navigation',
      )

      assert.deepEqual(pageErrors, [])
      console.log(
        `Packaged ${process.platform} boot, RPC/SQL/MCP/export/FX/clear flows, and one reused app/beacon/panel with sandboxed renderers passed.`,
      )
    } finally {
      for (const page of app.windows()) {
        await page.evaluate(() => globalThis.rpcProbe?.dispose()).catch(() => {})
      }
      await app.close()
    }
  } finally {
    const resolvedProfile = path.resolve(profile)
    assert.ok(path.basename(resolvedProfile).startsWith(profilePrefix))
    assert.equal(path.dirname(resolvedProfile), tempRoot)
    assert.notEqual(resolvedProfile, path.parse(resolvedProfile).root)
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
