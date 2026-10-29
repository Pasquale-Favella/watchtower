const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Worker } = require('node:worker_threads')
const { app, ipcMain, MessageChannelMain } = require('electron')
const CONNECT_CHANNEL = 'rpc:v1:connect'

const appDir = process.env.WATCHTOWER_MEASURE_APP_DIR
const scenarioFile = process.env.WATCHTOWER_MEASURE_SCENARIO_FILE
const reportFile = process.env.WATCHTOWER_MEASURE_REPORT_FILE

if (!appDir || !scenarioFile || !reportFile) {
  throw new Error('Renderer instrumentation requires its app directory and profile report paths')
}

app.setAppPath(appDir)

const report = {
  workerRequestsByScenario: {},
  observedWorkerCountByScenario: {},
  observedWorkerExitCountByScenario: {},
  observedWorkerCount: 0,
  observedWorkerExitCount: 0,
  rpcConnectAttemptsByScenario: {},
  bridgeRequestsByScenario: {},
  nativeRpcPortCount: 0,
  closedNativeRpcPortCount: 0,
  activeNativeRpcPortCount: 0,
  maximumActiveNativeRpcPortCount: 0,
  nativeRpcPortsOpenedByScenario: {},
  nativeRpcPortsClosedByScenario: {},
  nativeRpcPortListenerBoundsByScenario: {},
  messagePortHook: { supported: false, error: null },
  ipcListeners: { current: {}, maximum: {} },
  ipcHandlers: { current: {}, maximum: {} },
  ipcBoundsByScenario: {},
  nativeWindowEventTrace: [],
}
const observedWorkers = new WeakSet()
const listenerChannels = new Set()

const originalIpcOn = ipcMain.on.bind(ipcMain)
const originalIpcRemoveListener = ipcMain.removeListener.bind(ipcMain)
const connectListenerWrappers = new WeakMap()
ipcMain.on = (channel, listener) => {
  if (channel !== CONNECT_CHANNEL) return originalIpcOn(channel, listener)
  const wrapped = function (...args) {
    countByScenario(report.rpcConnectAttemptsByScenario, currentScenario(), 'attempts')
    return listener.apply(this, args)
  }
  connectListenerWrappers.set(listener, wrapped)
  return originalIpcOn(channel, wrapped)
}
ipcMain.removeListener = (channel, listener) =>
  originalIpcRemoveListener(channel, connectListenerWrappers.get(listener) ?? listener)

function parseRpcFrame(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function observedRpcTag(value) {
  const message = value && typeof value === 'object' && 'data' in value ? value.data : value
  const frame = parseRpcFrame(message)
  return operationTag(frame)
}

function findMethodOwner(target, property) {
  let prototype = Object.getPrototypeOf(target)
  while (prototype && !Object.prototype.hasOwnProperty.call(prototype, property)) {
    prototype = Object.getPrototypeOf(prototype)
  }
  if (!prototype) throw new Error(`MessagePortMain has no ${property} method`)
  return prototype
}

const sampleChannel = new MessageChannelMain()
const messagePortPrototype = Object.getPrototypeOf(sampleChannel.port1)
const portMethodOwner = findMethodOwner(sampleChannel.port1, 'on')
const originalPortOn = portMethodOwner.on
const originalPortRemoveListener = findMethodOwner(sampleChannel.port1, 'removeListener').removeListener
const originalPortListenerCount = findMethodOwner(sampleChannel.port1, 'listenerCount').listenerCount
const portStates = new WeakMap()
const portListenerWrappers = new WeakMap()

function recordPortListenerBound(port, state, eventName) {
  if (!['message', 'messageerror', 'close'].includes(eventName)) return
  const internalCloseListener = eventName === 'close' ? 1 : 0
  const count = Math.max(0, originalPortListenerCount.call(port, eventName) - internalCloseListener)
  const byScenario = (report.nativeRpcPortListenerBoundsByScenario[currentScenario()] ??= {})
  byScenario[eventName] = Math.max(byScenario[eventName] ?? 0, count)
  state.listenerMaximum[eventName] = Math.max(state.listenerMaximum[eventName] ?? 0, count)
}

function observeNativePort(port) {
  const existing = portStates.get(port)
  if (existing) return existing

  const state = { closed: false, listenerMaximum: {} }
  portStates.set(port, state)
  report.nativeRpcPortCount += 1
  report.activeNativeRpcPortCount += 1
  report.maximumActiveNativeRpcPortCount = Math.max(
    report.maximumActiveNativeRpcPortCount,
    report.activeNativeRpcPortCount,
  )
  countByScenario(report.nativeRpcPortsOpenedByScenario, currentScenario(), 'ports')
  originalPortOn.call(port, 'close', () => {
    if (state.closed) return
    state.closed = true
    report.closedNativeRpcPortCount += 1
    report.activeNativeRpcPortCount = Math.max(0, report.activeNativeRpcPortCount - 1)
    countByScenario(report.nativeRpcPortsClosedByScenario, currentScenario(), 'ports')
    writeReport()
  })
  return state
}

function wrapPortListener(port, eventName, listener) {
  let byEvent = portListenerWrappers.get(port)
  if (!byEvent) {
    byEvent = new Map()
    portListenerWrappers.set(port, byEvent)
  }
  let byListener = byEvent.get(eventName)
  if (!byListener) {
    byListener = new Map()
    byEvent.set(eventName, byListener)
  }
  const wrappers = byListener.get(listener) ?? []
  const wrapped = function (...args) {
    if (eventName === 'message') {
      const tag = observedRpcTag(args[0])
      if (tag !== undefined) countByScenario(report.bridgeRequestsByScenario, currentScenario(), tag)
    }
    return listener.apply(this, args)
  }
  wrappers.push(wrapped)
  byListener.set(listener, wrappers)
  return wrapped
}

if (messagePortPrototype.constructor?.name === 'MessagePortMain') {
  try {
    Object.defineProperty(messagePortPrototype, 'on', {
      configurable: true,
      writable: true,
      value: function (eventName, listener) {
        const state = observeNativePort(this)
        const wrapped =
          eventName === 'message' && typeof listener === 'function'
            ? wrapPortListener(this, eventName, listener)
            : listener
        const result = originalPortOn.call(this, eventName, wrapped)
        recordPortListenerBound(this, state, eventName)
        return result
      },
    })
    Object.defineProperty(messagePortPrototype, 'removeListener', {
      configurable: true,
      writable: true,
      value: function (eventName, listener) {
        const byEvent = portListenerWrappers.get(this)
        const byListener = byEvent?.get(eventName)
        const wrappers = byListener?.get(listener)
        const wrapped = wrappers?.pop() ?? listener
        if (wrappers?.length === 0) byListener.delete(listener)
        const result = originalPortRemoveListener.call(this, eventName, wrapped)
        const state = portStates.get(this)
        if (state) recordPortListenerBound(this, state, eventName)
        return result
      },
    })
    report.messagePortHook.supported = true
  } catch (error) {
    report.messagePortHook.error = String(error)
  }
} else {
  report.messagePortHook.error = 'MessageChannelMain port did not expose a dedicated MessagePortMain prototype'
}
sampleChannel.port1.close()
sampleChannel.port2.close()

function currentScenario() {
  try {
    return fs.readFileSync(scenarioFile, 'utf8').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function nativeWindowRole(window) {
  let pathname
  try {
    pathname = new URL(window.webContents.getURL()).pathname
  } catch {
    return 'unknown'
  }
  if (pathname.endsWith('/index.html')) return 'main'
  if (pathname.endsWith('/orb.html')) return 'orb'
  if (pathname.endsWith('/orb-panel.html')) return 'panel'
  return 'other'
}

app.on('browser-window-created', (_event, window) => {
  for (const eventName of ['ready-to-show', 'show', 'hide', 'focus', 'blur', 'close', 'closed']) {
    window.on(eventName, () => {
      report.nativeWindowEventTrace.push({
        scenario: currentScenario(),
        window: nativeWindowRole(window),
        event: eventName,
        visible: window.isDestroyed() ? null : window.isVisible(),
      })
      writeReport()
    })
  }
})

function countByScenario(target, scenario, key) {
  const counts = (target[scenario] ??= {})
  counts[key] = (counts[key] ?? 0) + 1
}

function operationTag(message) {
  let frame = message
  if (Array.isArray(frame) && frame[0] === 0) frame = frame[1]
  if (!frame || typeof frame !== 'object') return undefined
  if (frame._tag === 'Request' && typeof frame.tag === 'string') return frame.tag
  if (typeof frame.op === 'string') return frame.op
  return undefined
}

function observeWorker(worker, scenario) {
  if (observedWorkers.has(worker)) return
  observedWorkers.add(worker)
  report.observedWorkerCount += 1
  countByScenario(report.observedWorkerCountByScenario, scenario, 'workers')
  worker.once('exit', () => {
    report.observedWorkerExitCount += 1
    countByScenario(report.observedWorkerExitCountByScenario, currentScenario(), 'exits')
    writeReport()
  })
}

const originalPostMessage = Worker.prototype.postMessage
Worker.prototype.postMessage = function (message, ...transfer) {
  const scenario = currentScenario()
  observeWorker(this, scenario)
  const tag = operationTag(message)
  if (tag !== undefined) countByScenario(report.workerRequestsByScenario, scenario, tag)
  return originalPostMessage.call(this, message, ...transfer)
}

function updateBound(group, channel, current) {
  const key = String(channel)
  group.current[key] = current
  group.maximum[key] = Math.max(group.maximum[key] ?? 0, current)
}

function updateScenarioBound(scenario, type, channel, current) {
  const scenarioReport = (report.ipcBoundsByScenario[scenario] ??= {
    listeners: { current: {}, maximum: {} },
    handlers: { current: {}, maximum: {} },
  })
  updateBound(scenarioReport[type], channel, current)
}

function sampleIpcListeners() {
  const scenario = currentScenario()
  for (const channel of ipcMain.eventNames()) {
    listenerChannels.add(channel)
  }
  for (const channel of listenerChannels) {
    const count = ipcMain.listenerCount(channel)
    updateBound(report.ipcListeners, channel, count)
    updateScenarioBound(scenario, 'listeners', channel, count)
  }
  for (const [channel, count] of handlerCounts) {
    updateScenarioBound(scenario, 'handlers', channel, count)
  }
}

const originalHandle = ipcMain.handle.bind(ipcMain)
const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain)
const handlerCounts = new Map()
ipcMain.handle = (channel, listener) => {
  const result = originalHandle(channel, listener)
  const count = (handlerCounts.get(channel) ?? 0) + 1
  handlerCounts.set(channel, count)
  updateBound(report.ipcHandlers, channel, count)
  updateScenarioBound(currentScenario(), 'handlers', channel, count)
  return result
}
ipcMain.removeHandler = channel => {
  const result = originalRemoveHandler(channel)
  const count = Math.max(0, (handlerCounts.get(channel) ?? 0) - 1)
  handlerCounts.set(channel, count)
  updateBound(report.ipcHandlers, channel, count)
  updateScenarioBound(currentScenario(), 'handlers', channel, count)
  return result
}

function writeReport() {
  sampleIpcListeners()
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
}

const listenerSampler = setInterval(writeReport, 100)
listenerSampler.unref()
process.on('exit', writeReport)

import(pathToFileURL(path.join(appDir, 'out/main/index.js')).href).catch(error => {
  console.error('[renderer instrumentation] failed to load application main', error)
  app.exit(1)
})
