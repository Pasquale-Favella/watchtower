import type { WebContents } from 'electron'

import type { WorkspaceBrowserInput, WorkspaceBrowserOperation } from '@/shared/schemas/workspace-browser.js'

const MAX_SNAPSHOT_CHARS = 64_000
const MAX_SNAPSHOT_ELEMENTS = 60
const MAX_DIAGNOSTICS = 24
const MAX_DIAGNOSTIC_TEXT = 800
const MAX_RECORDING_BYTES = 32 * 1024 * 1024
const MAX_RECORDING_FRAMES = 900
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000

type CdpResult = Record<string, unknown>
type RecordingFrame = { readonly timestamp: number; readonly data: string }
type PendingPick = { resolve: (backendNodeId: number) => void; reject: (cause: Error) => void }

type CdpDebugger = WebContents['debugger']
type CdpMessageListener = (
  event: Electron.Event,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void

const error = (message: string): Error => new Error(message)
const boundedText = (value: unknown, max = MAX_DIAGNOSTIC_TEXT): string => String(value ?? '').slice(0, max)

const resultValue = (response: CdpResult): unknown => {
  if (response.exceptionDetails) throw error('The page could not complete that browser operation.')
  return (response.result as { value?: unknown } | undefined)?.value ?? null
}

const escapeForExpression = (value: string): string => JSON.stringify(value)

const locatorExpression = (input: WorkspaceBrowserInput): string => {
  if (input.ref) {
    const ref = input.ref.replace(/^aria-ref=/, '')
    return `document.querySelector('[data-watchtower-ref="' + CSS.escape(${escapeForExpression(ref)}) + '"]')`
  }
  if (input.selector) {
    return `document.querySelector(${escapeForExpression(input.selector)})`
  }
  return 'document.activeElement'
}

const targetBoxExpression = (input: WorkspaceBrowserInput): string => `(() => {
  const el = ${locatorExpression(input)};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
})()`

const snapshotExpression = (generation: number) => `(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  for (const el of document.querySelectorAll('[data-watchtower-ref]')) el.removeAttribute('data-watchtower-ref');
  const candidates = [];
  for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=true],[tabindex]:not([tabindex="-1"])')) {
    if (visible(el)) candidates.push(el);
    if (candidates.length >= ${MAX_SNAPSHOT_ELEMENTS}) break;
  }
  const nameOf = (el) => el.getAttribute('aria-label') || (el.labels && [...el.labels].map(label => label.innerText).join(' ')) || el.getAttribute('title') || el.innerText || (el.type === 'password' ? '' : el.getAttribute('placeholder')) || '';
  const roleOf = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName] || el.tagName.toLowerCase());
  const elements = candidates.map((el, index) => {
    const ref = 'g${generation}e' + (index + 1);
    el.setAttribute('data-watchtower-ref', ref);
    const rect = el.getBoundingClientRect();
    return { ref, tag: el.tagName.toLowerCase(), role: roleOf(el), name: String(nameOf(el)).trim().replace(/\\s+/g, ' ').slice(0, 120), selector: '[data-watchtower-ref="' + ref + '"]', x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), disabled: !!el.disabled };
  });
  const pageText = document.body?.innerText || '';
  const visibleText = pageText.slice(0, 8000);
  const accessibilityTree = elements.map((item) => item.role + (item.name ? ' "' + item.name + '"' : '') + ' [ref=' + item.ref + ']').join('\\n').slice(0, 16_000);
  return { url: location.href, title: document.title, loading: document.readyState !== 'complete', visibleText, truncated: pageText.length > 8000, interactiveElements: elements, accessibilityTree, viewport: { width: innerWidth, height: innerHeight } };
})()`

const KEY_CODES: Record<string, { keyCode: number; code: string; text?: string }> = {
  Enter: { keyCode: 13, code: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home' },
  End: { keyCode: 35, code: 'End' },
  PageDown: { keyCode: 34, code: 'PageDown' },
  PageUp: { keyCode: 33, code: 'PageUp' },
  Space: { keyCode: 32, code: 'Space', text: ' ' },
}

function modifierMask(key: string): number {
  const normalized = key.toLowerCase()
  return (
    (normalized.includes('alt') ? 1 : 0) |
    (normalized.includes('ctrl') || normalized.includes('control') ? 2 : 0) |
    (normalized.includes('meta') || normalized.includes('cmd') ? 4 : 0) |
    (normalized.includes('shift') ? 8 : 0)
  )
}

function keyDefinition(key: string): { key: string; code: string; keyCode: number; text?: string; modifiers: number } {
  const parts = key.split('+')
  const actualKey = parts.at(-1) ?? key
  const modifiers = modifierMask(parts.slice(0, -1).join('+'))
  const named = KEY_CODES[actualKey]
  if (named) return { key: actualKey, ...named, modifiers }
  if (actualKey.length === 1) {
    const upper = actualKey.toUpperCase()
    return {
      key: actualKey,
      code: /^[A-Z]$/.test(upper) ? `Key${upper}` : `Digit${actualKey}`,
      keyCode: actualKey.toUpperCase().charCodeAt(0),
      text: actualKey,
      modifiers,
    }
  }
  throw error('The requested browser key is not supported.')
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(error('Browser operation was cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(error('Browser operation was cancelled.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      cause => {
        cleanup()
        reject(cause)
      },
    )
  })
}

export interface PreviewAutomation {
  execute(operation: WorkspaceBrowserOperation, input: WorkspaceBrowserInput, signal?: AbortSignal): Promise<unknown>
  reset(): Promise<void>
  dispose(): void
}

/** CDP adapter for one Electron WebContents. It never starts or attaches to an external browser. */
export function createPreviewAutomation(contents: WebContents): PreviewAutomation {
  const debuggerApi: CdpDebugger = contents.debugger
  const ownsAttachment = !debuggerApi.isAttached()
  let disposed = false
  let attachment: Promise<void> | null = null
  let activeSignal: AbortSignal | undefined
  let operationQueue: Promise<void> = Promise.resolve()
  let recording: { frames: RecordingFrame[]; bytes: number; truncated: boolean } | null = null
  let pendingDialog: { type: string; message: string; defaultPrompt?: string } | null = null
  let pendingPick: PendingPick | null = null
  const consoleEntries: Array<{ level: string; text: string; timestamp: number }> = []
  const networkEntries: Array<{
    requestId: string
    url: string
    method: string
    status: number | null
    failed: boolean
    timestamp: number
  }> = []
  let refGeneration = 0

  const pushBounded = <A>(buffer: A[], value: A) => {
    buffer.push(value)
    if (buffer.length > MAX_DIAGNOSTICS) buffer.splice(0, buffer.length - MAX_DIAGNOSTICS)
  }

  const onMessage: CdpMessageListener = (_event, method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? (params.args as Array<{ value?: unknown; description?: string }>) : []
      pushBounded(consoleEntries, {
        level: boundedText(params.type, 32),
        text: boundedText(args.map(arg => arg.value ?? arg.description ?? '').join(' ')),
        timestamp: Number(params.timestamp ?? Date.now()),
      })
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry as { level?: string; text?: string; timestamp?: number } | undefined
      if (entry)
        pushBounded(consoleEntries, {
          level: boundedText(entry.level, 32),
          text: boundedText(entry.text),
          timestamp: Number(entry.timestamp ?? Date.now()),
        })
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request as { url?: string; method?: string } | undefined
      if (request)
        pushBounded(networkEntries, {
          requestId: boundedText(params.requestId, 128),
          url: boundedText(request.url, 8192),
          method: boundedText(request.method, 32),
          status: null,
          failed: false,
          timestamp: Number(params.timestamp ?? Date.now()),
        })
    } else if (method === 'Network.responseReceived') {
      const response = params.response as { url?: string; status?: number } | undefined
      if (response) {
        const entry = [...networkEntries].reverse().find(item => item.url === response.url && item.status === null)
        if (entry) {
          const index = networkEntries.lastIndexOf(entry)
          networkEntries[index] = { ...entry, status: Number(response.status ?? 0) }
        }
      }
    } else if (method === 'Network.loadingFailed') {
      const id = boundedText(params.requestId, 128)
      const entry = [...networkEntries].reverse().find(item => item.requestId === id && item.status === null)
      if (entry) {
        const index = networkEntries.lastIndexOf(entry)
        networkEntries[index] = { ...entry, failed: true }
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      pendingDialog = {
        type: boundedText(params.type, 32),
        message: boundedText(params.message),
        ...(typeof params.defaultPrompt === 'string' ? { defaultPrompt: boundedText(params.defaultPrompt) } : {}),
      }
    } else if (method === 'Page.javascriptDialogClosed') {
      pendingDialog = null
    } else if (method === 'Page.frameNavigated') {
      refGeneration += 1
    } else if (method === 'Page.navigatedWithinDocument') {
      refGeneration += 1
    } else if (method === 'Overlay.inspectNodeRequested') {
      const backendNodeId = Number(params.backendNodeId)
      if (pendingPick && Number.isInteger(backendNodeId)) pendingPick.resolve(backendNodeId)
    } else if (method === 'Page.screencastFrame' && recording) {
      const data = typeof params.data === 'string' ? params.data : ''
      const timestamp = Number((params.metadata as { timestamp?: number } | undefined)?.timestamp ?? Date.now())
      if (
        data &&
        recording.frames.length < MAX_RECORDING_FRAMES &&
        recording.bytes + data.length <= MAX_RECORDING_BYTES
      ) {
        recording.frames.push({ timestamp, data })
        recording.bytes += data.length
      } else {
        recording.truncated = true
      }
      const sessionId = Number(params.sessionId)
      if (Number.isInteger(sessionId)) void send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
    }
  }

  debuggerApi.on('message', onMessage)
  const onDebuggerDetach = () => {
    attachment = null
    refGeneration += 1
    recording = null
    pendingPick?.reject(error('Browser debugger disconnected during element picking.'))
  }
  debuggerApi.on('detach', onDebuggerDetach)
  const onBeforeInput = (event: Electron.Event, input: Electron.Input) => {
    if (!pendingPick || input.type !== 'keyDown' || input.key !== 'Escape') return
    event.preventDefault()
    pendingPick.reject(error('Browser element picking was cancelled.'))
  }
  contents.on('before-input-event', onBeforeInput)

  const ensureAttached = (): Promise<void> => {
    if (disposed) return Promise.reject(error('Browser automation is closed.'))
    if (attachment) return attachment
    attachment = (async () => {
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
      await debuggerApi.sendCommand('Page.enable')
      await debuggerApi.sendCommand('Runtime.enable')
      await debuggerApi.sendCommand('DOM.enable')
      await debuggerApi.sendCommand('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 })
      await debuggerApi.sendCommand('Log.enable').catch(() => undefined)
    })().catch(cause => {
      attachment = null
      throw cause
    })
    return attachment
  }

  function send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    if (disposed) return Promise.reject(error('Browser automation is closed.'))
    if (activeSignal?.aborted) return Promise.reject(error('Browser operation was cancelled.'))
    return withAbort(debuggerApi.sendCommand(method, params) as Promise<CdpResult>, activeSignal)
  }

  async function evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    return resultValue(response)
  }

  async function box(
    input: WorkspaceBrowserInput,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    if (input.ref && !input.ref.startsWith(`g${refGeneration}e`))
      throw error('That browser element reference is stale. Take a fresh snapshot.')
    const value = (await evaluate(targetBoxExpression(input), signal)) as {
      x?: number
      y?: number
      width?: number
      height?: number
    } | null
    if (
      !value ||
      typeof value.x !== 'number' ||
      !Number.isFinite(value.x) ||
      typeof value.y !== 'number' ||
      !Number.isFinite(value.y)
    )
      throw error('The browser target was not found.')
    return { x: value.x, y: value.y, width: value.width ?? 0, height: value.height ?? 0 }
  }

  const clickAt = async (x: number, y: number, button: string, clickCount = 1, signal?: AbortSignal) => {
    const protocolButton = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left'
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: protocolButton, clickCount })
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: protocolButton, clickCount })
  }

  async function press(key: string, modifiers?: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw error('Browser operation was cancelled.')
    const definition = keyDefinition(key)
    const modifier = modifierMask(modifiers ?? '')
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      modifiers: definition.modifiers | modifier,
    })
    if (definition.text && (definition.modifiers | modifier) === 0)
      await send('Input.insertText', { text: definition.text })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      modifiers: definition.modifiers | modifier,
    })
  }

  async function waitFor(input: WorkspaceBrowserInput, signal?: AbortSignal): Promise<unknown> {
    const timeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (signal?.aborted) throw error('Browser operation was cancelled.')
      const selector = input.ref
        ? `!!document.querySelector('[data-watchtower-ref="' + CSS.escape(${escapeForExpression(input.ref)}) + '"]')`
        : input.selector
          ? `!!document.querySelector(${escapeForExpression(input.selector)})`
          : 'true'
      const text = input.text ? `document.body?.innerText?.includes(${escapeForExpression(input.text)})` : 'true'
      const url = input.url ? `location.href.includes(${escapeForExpression(input.url)})` : 'true'
      const expression = input.expression ? `!!(${input.expression})` : 'true'
      const matched = await evaluate(`(${selector}) && (${text}) && (${url}) && (${expression})`, signal)
      if (matched) return { matched: true }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const timer = setTimeout(done, 100)
        const abort = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          reject(error('Browser operation was cancelled.'))
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw error('The browser page did not reach the requested condition before the timeout.')
  }

  async function executeOne(
    operation: WorkspaceBrowserOperation,
    input: WorkspaceBrowserInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await withAbort(ensureAttached(), signal)
    try {
      if (pendingDialog && operation !== 'snapshot' && operation !== 'dialog') {
        throw error('A browser dialog is open. Resolve it with the dialog action first.')
      }
      const result = await (async (): Promise<unknown> => {
        switch (operation) {
          case 'snapshot': {
            if (pendingDialog) {
              return {
                url: boundedText(contents.getURL(), 8_192),
                title: boundedText(contents.getTitle(), 512),
                loading: contents.isLoading(),
                visibleText: '',
                interactiveElements: [],
                accessibilityTree: '',
                console: consoleEntries.slice(-12).map(({ level, text, timestamp }) => ({
                  level,
                  text: text.slice(0, 500),
                  timestamp,
                })),
                network: networkEntries.slice(-12).map(entry => ({
                  url: entry.url,
                  method: entry.method,
                  status: entry.status,
                  failed: entry.failed,
                  timestamp: entry.timestamp,
                })),
                dialog: pendingDialog,
              }
            }
            const snapshot = (await evaluate(snapshotExpression(++refGeneration), signal)) as Record<string, unknown>
            const axResponse: CdpResult = input.includeDiagnostics
              ? await send('Accessibility.getFullAXTree').catch(() => ({}) as CdpResult)
              : {}
            const axNodes = Array.isArray(axResponse.nodes)
              ? (axResponse.nodes as Array<{
                  ignored?: boolean
                  role?: { value?: unknown }
                  name?: { value?: unknown }
                  value?: { value?: unknown }
                }>)
              : []
            const accessibilityTree =
              axNodes.length > 0
                ? axNodes
                    .filter(node => !node.ignored)
                    .slice(0, 200)
                    .map(node => {
                      const role = boundedText(node.role?.value, 80)
                      const name = boundedText(node.name?.value, 240)
                      return `${role}${name ? ` "${name}"` : ''}`
                    })
                    .join('\n')
                    .slice(0, 16_000)
                : String(snapshot.accessibilityTree ?? '').slice(0, 16_000)
            const payload: Record<string, unknown> = {
              ...snapshot,
              visibleText: String(snapshot.visibleText ?? '').slice(0, 24_000),
              accessibilityTree,
              console: (input.includeDiagnostics ? consoleEntries : [])
                .slice(-12)
                .map(({ level, text, timestamp }) => ({ level, text: text.slice(0, 500), timestamp })),
              network: (input.includeDiagnostics ? networkEntries : [])
                .slice(-12)
                .map(({ url, method, status, failed, timestamp }) => ({
                  url: url.slice(0, 500),
                  method,
                  status,
                  failed,
                  timestamp,
                })),
              dialog: pendingDialog,
            }
            while (JSON.stringify(payload).length > MAX_SNAPSHOT_CHARS) {
              const network = payload.network as unknown[]
              if (network.length > 0) network.shift()
              else {
                const logs = payload.console as unknown[]
                if (logs.length > 0) logs.shift()
                else {
                  const visibleText = String(payload.visibleText ?? '')
                  if (visibleText) payload.visibleText = visibleText.slice(0, Math.floor(visibleText.length * 0.75))
                  else {
                    const tree = String(payload.accessibilityTree ?? '')
                    if (tree) payload.accessibilityTree = tree.slice(0, Math.floor(tree.length * 0.75))
                    else {
                      const elements = payload.interactiveElements as unknown[]
                      if (elements.length > 0) elements.pop()
                      else break
                    }
                  }
                }
              }
            }
            return payload
          }
          case 'click': {
            const target =
              input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : await box(input, signal)
            await clickAt(target.x, target.y, input.button ?? 'left', input.clickCount ?? 1, signal)
            return { clicked: true }
          }
          case 'type': {
            const hasTarget = Boolean(input.selector || input.ref)
            if (hasTarget) {
              const target = await box(input, signal)
              await clickAt(target.x, target.y, 'left', 1, signal)
            }
            const editable = await evaluate(
              `(() => {
              const el = ${locatorExpression(input)};
              if (!el || el.disabled || el.readOnly) return false;
              if (el.isContentEditable) return true;
              if (el instanceof HTMLTextAreaElement) return true;
              if (!(el instanceof HTMLInputElement)) return false;
              return ['text','search','email','url','tel','password','number'].includes(el.type);
            })()`,
              signal,
            )
            if (!editable) throw error('The browser target is not an editable field.')
            if (input.clear ?? hasTarget) {
              const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
              await press(selectAll, undefined, signal)
              await press('Backspace', undefined, signal)
            }
            const text = input.text ?? input.value ?? ''
            await send('Input.insertText', { text })
            return { typed: true }
          }
          case 'press':
            await press(input.key ?? 'Enter', undefined, signal)
            return { pressed: true }
          case 'scroll': {
            const target = input.selector || input.ref ? await box(input, signal) : { x: input.x ?? 0, y: input.y ?? 0 }
            await send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: target.x,
              y: target.y,
              deltaX: input.deltaX ?? 0,
              deltaY: input.deltaY ?? 0,
            })
            return { scrolled: true }
          }
          case 'evaluate': {
            const value = await evaluate(input.expression ?? 'null', signal)
            const encoded = JSON.stringify(value)
            if (encoded && encoded.length > MAX_SNAPSHOT_CHARS)
              throw error('The page result exceeds the browser response limit.')
            return { value }
          }
          case 'waitFor':
            return waitFor(input, signal)
          case 'resize': {
            if ((input.width === undefined) !== (input.height === undefined))
              throw error('Browser viewport width and height must be set together.')
            if (input.width === undefined || input.height === undefined) {
              await send('Emulation.clearDeviceMetricsOverride')
              return { resized: true, mode: 'fill' }
            }
            const width = input.width
            const height = input.height
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
            return { width, height }
          }
          case 'setColorScheme':
            await send('Emulation.setEmulatedMedia', {
              features:
                input.colorScheme === undefined || input.colorScheme === 'system'
                  ? []
                  : [{ name: 'prefers-color-scheme', value: input.colorScheme }],
            })
            return { colorScheme: input.colorScheme ?? 'system' }
          case 'hover': {
            const target =
              input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : await box(input, signal)
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
            return { hovered: true }
          }
          case 'select': {
            const selector = locatorExpression(input)
            const values = input.values ?? (input.value === undefined ? [] : [input.value])
            const selected = await evaluate(
              `(() => { const el = ${selector}; if (!(el instanceof HTMLSelectElement)) return null; const wanted = ${JSON.stringify(values)}; for (const option of el.options) option.selected = wanted.includes(option.value) || wanted.includes(option.label); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return [...el.selectedOptions].map(option => option.value); })()`,
              signal,
            )
            if (!Array.isArray(selected)) throw error('The browser target is not a select element.')
            return { selected }
          }
          case 'drag': {
            const source = await box({ ...input, selector: input.selector ?? input.ref, ref: undefined }, signal)
            const target = await box({ selector: input.targetSelector }, signal)
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: source.x, y: source.y })
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: source.x, y: source.y, button: 'left' })
            for (let step = 1; step <= 8; step += 1) {
              const ratio = step / 8
              await send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: source.x + (target.x - source.x) * ratio,
                y: source.y + (target.y - source.y) * ratio,
                button: 'left',
              })
            }
            await send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: target.x,
              y: target.y,
              button: 'left',
            })
            return { dragged: true }
          }
          case 'upload': {
            const inputSelector = locatorExpression(input)
            const node = await send('Runtime.evaluate', {
              expression: `(() => { const el = ${inputSelector}; return el && el.tagName === 'INPUT' && el.type === 'file' ? el : null })()`,
              objectGroup: 'watchtower-upload',
            })
            const objectId = (node.result as { objectId?: string } | undefined)?.objectId
            if (!objectId) throw error('The browser target is not a file input.')
            const { nodeId } = (await send('DOM.requestNode', { objectId })) as { nodeId: number }
            await send('DOM.setFileInputFiles', { nodeId, files: input.files ?? [] })
            await send('Runtime.releaseObjectGroup', { objectGroup: 'watchtower-upload' }).catch(() => undefined)
            return { uploaded: true }
          }
          case 'dialog':
            if (!pendingDialog) throw error('There is no browser dialog to resolve.')
            await send('Page.handleJavaScriptDialog', {
              accept: input.accept ?? true,
              ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
            })
            pendingDialog = null
            return { resolved: true }
          case 'recordingStart': {
            if (recording) return { started: true }
            recording = { frames: [], bytes: 0, truncated: false }
            await send('Page.startScreencast', {
              format: 'jpeg',
              quality: 55,
              maxWidth: 1280,
              maxHeight: 1280,
              everyNthFrame: 2,
            })
            return { started: true, format: 'jpeg-frames', maxBytes: MAX_RECORDING_BYTES }
          }
          case 'recordingStop': {
            if (!recording) throw error('Browser recording is not active.')
            const current = recording
            recording = null
            await send('Page.stopScreencast')
            return {
              format: 'jpeg-frames',
              frameRate: 30,
              truncated: current.truncated,
              frames: current.frames,
              sizeBytes: Math.ceil((current.bytes * 3) / 4),
            }
          }
          case 'pick': {
            try {
              const timeoutMs = Math.min(input.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS)
              let settled = false
              let resolvePick!: (backendNodeId: number) => void
              let rejectPick!: (cause: Error) => void
              const pickedNode = new Promise<number>((resolve, reject) => {
                resolvePick = resolve
                rejectPick = reject
              })
              const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
                if (pendingPick === pending) pendingPick = null
              }
              const finish = (callback: () => void) => {
                if (settled) return
                settled = true
                cleanup()
                callback()
              }
              const pending: PendingPick = {
                resolve: value => finish(() => resolvePick(value)),
                reject: cause => finish(() => rejectPick(cause)),
              }
              const abort = () => pending.reject(error('Browser element picking was cancelled.'))
              pendingPick = pending
              const timer = setTimeout(() => pending.reject(error('Browser element picking timed out.')), timeoutMs)
              signal?.addEventListener('abort', abort, { once: true })
              if (signal?.aborted) abort()
              try {
                await send('Overlay.enable')
                await send('Overlay.setInspectMode', {
                  mode: 'searchForNode',
                  highlightConfig: {
                    showInfo: true,
                    contentColor: { r: 70, g: 130, b: 255, a: 0.25 },
                    borderColor: { r: 70, g: 130, b: 255, a: 0.9 },
                  },
                })
              } catch {
                pending.reject(error('Browser element picking could not start.'))
              }
              const backendNodeId = await pickedNode
              const resolved = await send('DOM.resolveNode', { backendNodeId })
              const objectId = (resolved.object as { objectId?: string } | undefined)?.objectId
              if (!objectId) throw error('The selected browser element is no longer available.')
              const inspected = await send('Runtime.callFunctionOn', {
                objectId,
                returnByValue: true,
                functionDeclaration: `function() {
                  const el = this;
                  const document = el.ownerDocument;
                  const selectorFor = (node) => {
                    const root = node.getRootNode();
                    if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
                    const parts = [];
                    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
                      if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
                        parts.unshift('#' + CSS.escape(node.id));
                        break;
                      }
                      let part = node.localName;
                      let sibling = node;
                      let index = 1;
                      while ((sibling = sibling.previousElementSibling)) if (sibling.localName === node.localName) index++;
                      if (index > 1) part += ':nth-of-type(' + index + ')';
                      parts.unshift(part);
                      node = node.parentElement;
                    }
                    const prefix = root instanceof ShadowRoot || parts[0]?.startsWith('#') ? '' : 'html > ';
                    return (prefix + parts.join(' > ')).slice(0, 2000);
                  };
                  const rect = el.getBoundingClientRect();
                  const root = el.getRootNode();
                  const shadowHost = root instanceof ShadowRoot ? root.host : null;
                  const selector = selectorFor(el);
                  const fullSelector = shadowHost ? selectorFor(shadowHost) + ' >>> ' + selector : selector;
                  const clone = el.cloneNode(true);
                  for (const field of clone.querySelectorAll('input[type="password"]')) {
                    field.value = '';
                    field.removeAttribute('value');
                  }
                  if (clone.matches('input[type="password"]')) {
                    clone.value = '';
                    clone.removeAttribute('value');
                  }
                  const tag = el.localName;
                  const role = el.getAttribute('role') || ({a:'link',button:'button',input:el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',textarea:'textbox',select:'combobox'}[tag] || tag);
                  const label = el.labels && [...el.labels].map(label => label.innerText).join(' ').trim();
                  const name = el.getAttribute('aria-label') || label || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || '';
                  const style = getComputedStyle(el);
                  const styles = ['display','position','width','height','margin','padding','gap','alignItems','justifyContent','gridTemplateColumns','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','border','borderRadius','boxShadow','overflow'].map(key => key + ': ' + style[key]).join('; ');
                  let componentName = null;
                  let source = null;
                  for (const key of Object.keys(el)) {
                    if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
                    let fiber = el[key];
                    for (let depth = 0; fiber && depth < 40 && (!componentName || !source); depth++) {
                      const type = fiber.type;
                      componentName ||= typeof type === 'function' ? type.displayName || type.name || null : null;
                      const debug = fiber._debugSource;
                      if (debug && debug.fileName) source ||= debug.fileName + (debug.lineNumber ? ':' + debug.lineNumber : '');
                      const stack = fiber._debugStack?.stack || fiber._debugOwner?._debugStack?.stack;
                      if (!source && typeof stack === 'string') {
                        const location = stack.split('\\n').find(frame => /:\\d+:\\d+/.test(frame));
                        if (location) source = location.trim().slice(0, 1024);
                      }
                      fiber = fiber.return;
                    }
                    break;
                  }
                  return { selector: fullSelector, tag, role, name: String(name).trim().replace(/\\s+/g, ' ').slice(0, 1000), href: el instanceof HTMLAnchorElement ? el.href.slice(0,8192) : null, componentName: componentName?.slice(0,256) ?? null, source: source?.slice(0,1024) ?? null, styles: styles.slice(0, 2000), text: (el.innerText || el.textContent || '').trim().slice(0, 1000), outerHTML: clone.outerHTML.slice(0, 4000), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight } };
                }`,
              })
              const picked = (inspected.result as { value?: unknown } | undefined)?.value
              if (!picked || typeof picked !== 'object')
                throw error('The selected browser element is no longer available.')
              return picked
            } finally {
              await debuggerApi.sendCommand('Overlay.setInspectMode', { mode: 'none' }).catch(() => undefined)
              await debuggerApi.sendCommand('Overlay.disable').catch(() => undefined)
            }
          }
        }
      })()
      const encoded = JSON.stringify(result)
      if (encoded && encoded.length > MAX_SNAPSHOT_CHARS && operation !== 'recordingStop')
        throw error('The browser response exceeds the size limit.')
      return result
    } catch (cause) {
      if (
        cause instanceof Error &&
        /^(A browser dialog|The browser|That browser|Browser element|Browser operation|The requested browser|The page|There is no browser|Browser recording)/.test(
          cause.message,
        )
      )
        throw cause
      throw error(`Browser ${operation} failed.`)
    }
  }

  function execute(
    operation: WorkspaceBrowserOperation,
    input: WorkspaceBrowserInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = operationQueue.then(async () => {
      if (signal?.aborted) throw error('Browser operation was cancelled.')
      activeSignal = signal
      const cancelExecution = () => {
        void debuggerApi.sendCommand('Runtime.terminateExecution').catch(() => undefined)
      }
      signal?.addEventListener('abort', cancelExecution, { once: true })
      try {
        return await executeOne(operation, input, signal)
      } finally {
        signal?.removeEventListener('abort', cancelExecution)
        activeSignal = undefined
      }
    })
    operationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function reset(): Promise<void> {
    await operationQueue
    const wasRecording = recording !== null
    recording = null
    if (wasRecording && debuggerApi.isAttached())
      await debuggerApi.sendCommand('Page.stopScreencast').catch(() => undefined)
    attachment = null
    if (ownsAttachment && debuggerApi.isAttached()) debuggerApi.detach()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    debuggerApi.off('message', onMessage)
    debuggerApi.off('detach', onDebuggerDetach)
    contents.off('before-input-event', onBeforeInput)
    pendingPick?.reject(error('Browser automation is closed.'))
    if (recording && debuggerApi.isAttached())
      void debuggerApi.sendCommand('Page.stopScreencast').catch(() => undefined)
    recording = null
    attachment = null
    if (ownsAttachment && debuggerApi.isAttached()) debuggerApi.detach()
  }

  return { execute, reset, dispose }
}
