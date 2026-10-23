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
async function checkRendererRpc(window) {
  const result = await window.evaluate(async () => {
    const bridge = window.api.rpcV1
    const connection = await bridge.connect()
    if (connection._tag !== 'Connected') throw new Error('Packaged RPC connection failed')
    const invoke = (id, tag, payload) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Packaged RPC timed out'))
        }, 10000)
        const unsubscribe = bridge.onMessage(raw => {
          const frame = JSON.parse(raw)
          if (frame._tag !== 'Exit' || frame.requestId !== id) return
          clearTimeout(timeout)
          unsubscribe()
          if (frame.exit._tag === 'Success') resolve(frame.exit.value)
          else reject(new Error('Packaged RPC request failed'))
        }, connection.generation)
        bridge
          .send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }), connection.generation)
          .catch(error => {
            clearTimeout(timeout)
            unsubscribe()
            reject(error)
          })
      })
    const name = 'watchtower-packaged-rpc-model'
    const status = await invoke('packaged-rpc-status', 'store:status', null)
    await invoke('packaged-rpc-price', 'models:setPrice', {
      model: name,
      inputPricePerMillion: 0,
      outputPricePerMillion: 2,
    })
    const prices = await invoke('packaged-rpc-prices', 'models:getPriceOverrides', null)
    await invoke('packaged-rpc-remove', 'models:removePriceOverride', { model: name })
    return { status, price: prices.find(price => price.model === name) }
  })
  assert.equal(result.status.scanned, true)
  assert.deepEqual(result.price, {
    model: 'watchtower-packaged-rpc-model',
    inputPricePerMillion: 0,
    outputPricePerMillion: 2,
  })
  console.log('Packaged sandbox RPC query and admitted configuration write passed over MessagePort.')
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
      const window = await app.firstWindow({ timeout: 60000 })
      const pageErrors = []
      window.on('pageerror', error => pageErrors.push(error))
      await expect(window).toHaveTitle(/Watchtower/)
      await window.evaluate(() => window.api.setCadence('manual'))
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
          optimize: await window.api.getOptimize(scope),
          yield: await window.api.getYield(scope),
          skills: await window.api.getSkills(scope),
        }
      })
      assert.ok(migratedPayloads.optimize && Array.isArray(migratedPayloads.optimize.findings))
      assert.ok(migratedPayloads.yield && Array.isArray(migratedPayloads.yield.details))
      assert.ok(migratedPayloads.skills && Array.isArray(migratedPayloads.skills.drafts))
      const sessionPayloads = await window.evaluate(async () => {
        const projects = await window.api.getProjects()
        const sessions = await window.api.getSessions({})
        const detail = sessions.length ? await window.api.getSession(sessions[0].sessionId) : null
        const term = detail?.turns
          .find(turn => turn.userMessage.trim())
          ?.userMessage.trim()
          .slice(0, 24)
        return {
          projects,
          sessions,
          detail,
          term,
          hits: term ? await window.api.search(term) : [],
          missing: await window.api.getSession('watchtower-packaged-missing-session'),
          blank: await window.api.search('  \t '),
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
        'Packaged project/session rows, targeted detail, positive search, missing detail and blank search IPC passed.',
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
          csv: await window.api.exportData('csv', csv),
          json: await window.api.exportData('json', json),
          harnesses: await window.api.getCoachHarnesses(),
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
        const api = window.api
        const name = 'watchtower-wave20-gate-model'
        const cadence = await api.getCadence()
        const manual = await api.setCadence('manual')
        const restoredCadence = await api.setCadence(cadence)
        await api.addModelAlias(` ${name} `, ' target-model ')
        const aliases = await api.getModelAliases()
        await api.setModelPrice(` ${name} `, 0, 2)
        const prices = await api.getPriceOverrides()
        await api.removeModelAlias(` ${name} `)
        await api.removePriceOverride(` ${name} `)
        const remainingAliases = await api.getModelAliases()
        const remainingPrices = await api.getPriceOverrides()
        const dismissal = await api.dismissSkill({ source: 'bash', name: 'wave20-gate', reason: 'fixture' })
        const status = await api.getScanStatus()
        const startup = await api.setLedgerMcpStartupMode('on-demand')
        const invalid = await api.setModelPrice(name, -1, 0).then(
          () => 'accepted',
          error => error.message,
        )
        return {
          name,
          manual,
          cadence,
          restoredCadence,
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
      assert.ok(config.invalid.includes('prices must be non-negative numbers'))
      console.log(
        'Packaged configuration ports passed: cadence, aliases and price CRUD, zero price, dismissal, startup, source status and failed validation.',
      )
      const inspection = await window.evaluate(async rows => {
        const harness = rows.find(row => row.kind === 'codex') ?? rows.find(row => row.kind === 'claude')
        if (!harness) return { skipped: true }
        const result = await window.api.inspectCoachHarness(harness.instanceId)
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
      const refused = await window.evaluate(async target => window.api.exportData('csv', target), protectedFolder)
      assert.equal(refused.ok, false)
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'untouched')
      console.log(
        'Packaged export CSV/JSON, marker/schema/currency coherence, protected destination and main-owned harness IPC passed.',
      )
      await checkMcp(runtimeExecutablePath, entryPath, path.join(userData, 'ledger.db'))
      await checkMcpHttp(runtimeExecutablePath, entryPath, path.join(userData, 'ledger.db'))
      const cleared = await window.evaluate(async () => {
        const api = window.api
        await api.setCadence('manual')
        const selected = await api.setCurrency('EUR')
        const cached = await api.getCurrency()
        const invalid = await api.setCurrency(' eur ').then(
          () => 'accepted',
          error => error.message,
        )
        await api.setCurrency('USD')
        await api.addModelAlias('wave20-clear-config', 'target-model')
        await api.setModelPrice('wave20-clear-config', 0, 2)
        const info = await api.clearData()
        return {
          selected,
          cached,
          invalid,
          info,
          currency: await api.getCurrency(),
          cadence: await api.getCadence(),
          aliases: await api.getModelAliases(),
          prices: await api.getPriceOverrides(),
          startup: await api.getLedgerMcpStatus(),
          status: await api.getScanStatus(),
          projects: await api.getProjects(),
          sessions: await api.getSessions({}),
        }
      })
      assert.equal(cleared.selected.code, 'EUR')
      assert.equal(cleared.cached.code, 'EUR')
      assert.ok(cleared.invalid.includes('invalid ISO 4217 currency code'))
      assert.equal(path.resolve(cleared.info.dataDir), path.resolve(profile))
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
        'Packaged currency select/cache/validation and clear/reclaim IPC passed; facts cleared, config retained.',
      )

      assert.deepEqual(pageErrors, [])
      assert.equal(app.windows().length, 1)
      console.log(
        `Packaged ${process.platform} boot, real scan, onboarding, analytics navigation, migrated IPC payloads, and renderer error checks passed.`,
      )
    } finally {
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
