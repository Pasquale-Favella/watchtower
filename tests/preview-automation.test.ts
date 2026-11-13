import { EventEmitter } from 'node:events'

import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPreviewAutomation } from '../src/platform/electron/main/preview/preview-automation.js'

function makeContents(
  overrides: {
    readonly sendCommand?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
    readonly initiallyAttached?: boolean
    readonly beforeInput?: EventEmitter
  } = {},
) {
  const events = new EventEmitter()
  const contentsEvents = Object.assign(overrides.beforeInput ?? new EventEmitter(), {
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isLoading: () => false,
  })
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let attached = overrides.initiallyAttached ?? false
  const debuggerApi = Object.assign(events, {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (overrides.sendCommand) return overrides.sendCommand(method, params)
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '')
        if (expression.includes('interactiveElements')) {
          const generation = /g(\d+)e/.exec(expression)?.[1] ?? '1'
          return {
            result: {
              value: {
                url: 'https://example.test/',
                title: 'Example',
                loading: false,
                visibleText: 'Example page',
                interactiveElements: [{ ref: `g${generation}e1`, role: 'button', name: 'Continue' }],
                accessibilityTree: `button "Continue" [ref=g${generation}e1]`,
                viewport: { width: 800, height: 600 },
              },
            },
          }
        }
        if (expression.includes('getBoundingClientRect'))
          return { result: { value: { x: 100, y: 75, width: 80, height: 30 } } }
        return { result: { value: true } }
      }
      if (method === 'Runtime.evaluate' && params.objectGroup) return { result: { objectId: 'object-1' } }
      if (method === 'DOM.requestNode') return { nodeId: 9 }
      return {}
    }),
  })
  return {
    contents: Object.assign(contentsEvents, { debugger: debuggerApi }) as unknown as WebContents,
    calls,
    debuggerApi,
    contentsEvents,
    detachDebugger: () => {
      attached = false
      debuggerApi.emit('detach', {}, 'target_closed')
    },
  }
}

describe('Electron preview automation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('attaches to the page debugger and returns a bounded snapshot with generation refs', async () => {
    const { contents, calls, debuggerApi } = makeContents()
    const automation = createPreviewAutomation(contents)
    const snapshot = (await automation.execute('snapshot', {})) as {
      interactiveElements: Array<{ ref: string }>
      visibleText: string
    }

    expect(debuggerApi.attach).toHaveBeenCalledWith('1.3')
    expect(calls.map(call => call.method)).toContain('Network.enable')
    expect(snapshot.interactiveElements[0]?.ref).toBe('g1e1')
    expect(snapshot.visibleText).toBe('Example page')
    expect(calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false)
    automation.dispose()
    expect(debuggerApi.detach).toHaveBeenCalledOnce()
  })

  it('rejects a ref from an earlier snapshot and dispatches trusted mouse input for a current ref', async () => {
    const { contents, calls } = makeContents()
    const automation = createPreviewAutomation(contents)
    await automation.execute('snapshot', {})
    await automation.execute('snapshot', {})

    await expect(automation.execute('click', { ref: 'g1e1' })).rejects.toThrow('stale')
    await automation.execute('click', { ref: 'g2e1', clickCount: 2 })
    expect(calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    expect(
      calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')?.params
        .clickCount,
    ).toBe(2)
    automation.dispose()
  })

  it('clears viewport emulation for fill mode and resets system color scheme', async () => {
    const { contents, calls } = makeContents()
    const automation = createPreviewAutomation(contents)
    await automation.execute('resize', {})
    await automation.execute('setColorScheme', { colorScheme: 'system' })
    expect(calls).toContainEqual({ method: 'Emulation.clearDeviceMetricsOverride', params: {} })
    expect(calls).toContainEqual({ method: 'Emulation.setEmulatedMedia', params: { features: [] } })
    automation.dispose()
  })

  it('types only into editable controls and clears a targeted field before inserting text', async () => {
    const { contents, calls } = makeContents()
    const automation = createPreviewAutomation(contents)
    await automation.execute('type', { selector: '#query', text: 'watchtower' })
    expect(calls.some(call => call.method === 'Input.insertText' && call.params.text === 'watchtower')).toBe(true)
    expect(calls.some(call => call.method === 'Input.insertText' && call.params.text === 'a')).toBe(false)
    expect(calls.some(call => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Backspace')).toBe(true)
    automation.dispose()
  })

  it('does not type into noneditable targets', async () => {
    const { contents, calls } = makeContents({
      sendCommand: async (method, params) => {
        if (method === 'Runtime.evaluate' && String(params.expression).includes('getBoundingClientRect'))
          return { result: { value: { x: 100, y: 75, width: 80, height: 30 } } }
        if (method === 'Runtime.evaluate') return { result: { value: false } }
        return {}
      },
    })
    const automation = createPreviewAutomation(contents)
    await expect(automation.execute('type', { selector: '#label', text: 'text' })).rejects.toThrow('editable')
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false)
    automation.dispose()
  })

  it('uses the bounded CDP accessibility tree and omits control values', async () => {
    const { contents } = makeContents({
      sendCommand: async method => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: {
                url: 'https://example.test/',
                title: 'Example',
                loading: false,
                visibleText: 'Example',
                interactiveElements: [],
                accessibilityTree: 'fallback',
                viewport: { width: 800, height: 600 },
              },
            },
          }
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { ignored: false, role: { value: 'button' }, name: { value: 'Continue' }, value: { value: 'secret' } },
              { ignored: true, role: { value: 'generic' }, name: { value: 'hidden' } },
            ],
          }
        }
        return {}
      },
    })
    const automation = createPreviewAutomation(contents)
    const snapshot = (await automation.execute('snapshot', { includeDiagnostics: true })) as {
      accessibilityTree: string
    }
    expect(snapshot.accessibilityTree).toBe('button "Continue"')
    expect(snapshot.accessibilityTree).not.toContain('secret')
    automation.dispose()
  })

  it('returns dialog metadata without evaluating the blocked page and gates other actions', async () => {
    const { contents, calls, debuggerApi } = makeContents()
    const automation = createPreviewAutomation(contents)
    debuggerApi.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: '',
    })

    const snapshot = (await automation.execute('snapshot', {})) as { dialog: { type: string; message: string } }
    expect(snapshot.dialog).toEqual({ type: 'confirm', message: 'Continue?', defaultPrompt: '' })
    expect(calls.some(call => call.method === 'Runtime.evaluate')).toBe(false)
    await expect(automation.execute('click', { x: 10, y: 10 })).rejects.toThrow('dialog is open')
    await automation.execute('dialog', { accept: true })
    expect(calls.some(call => call.method === 'Page.handleJavaScriptDialog')).toBe(true)
    automation.dispose()
  })

  it('cancels in-flight page evaluation and does not continue to page input', async () => {
    let finishEvaluation: ((value: Record<string, unknown>) => void) | undefined
    let evaluationStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      evaluationStarted = resolve
    })
    const { contents, calls } = makeContents({
      sendCommand: async method => {
        if (method === 'Runtime.evaluate')
          return new Promise(resolve => {
            finishEvaluation = resolve
            evaluationStarted?.()
          })
        if (method === 'Runtime.terminateExecution') {
          finishEvaluation?.({ result: { value: true } })
          return {}
        }
        return {}
      },
    })
    const automation = createPreviewAutomation(contents)
    const controller = new AbortController()
    const running = automation.execute('evaluate', { expression: 'true' }, controller.signal)
    await started
    controller.abort()
    await expect(running).rejects.toThrow('cancelled')
    expect(calls.some(call => call.method === 'Runtime.terminateExecution')).toBe(true)
    expect(calls.some(call => call.method.startsWith('Input.'))).toBe(false)
    automation.dispose()
  })

  it('keeps an existing debugger attachment when disposed', async () => {
    const { contents, debuggerApi } = makeContents({ initiallyAttached: true })
    const automation = createPreviewAutomation(contents)
    await automation.execute('snapshot', {})
    automation.dispose()
    expect(debuggerApi.attach).not.toHaveBeenCalled()
    expect(debuggerApi.detach).not.toHaveBeenCalled()
  })

  it('reattaches after Electron detaches its debugger session', async () => {
    const { contents, debuggerApi, detachDebugger } = makeContents()
    const automation = createPreviewAutomation(contents)
    await automation.execute('snapshot', {})
    detachDebugger()
    await automation.execute('snapshot', {})
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2)
    automation.dispose()
  })

  it('returns the selected DOM node from native CDP inspect mode and clears inspection', async () => {
    let inspectStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      inspectStarted = resolve
    })
    const { contents, calls, debuggerApi } = makeContents({
      sendCommand: async method => {
        if (method === 'Overlay.setInspectMode') inspectStarted?.()
        if (method === 'DOM.resolveNode') return { object: { objectId: 'selected-node' } }
        if (method === 'Runtime.callFunctionOn')
          return {
            result: {
              value: {
                selector: '#picked',
                tag: 'button',
                text: 'Continue',
                outerHTML: '<button>Continue</button>',
                rect: { x: 1, y: 2, width: 3, height: 4 },
              },
            },
          }
        return {}
      },
    })
    const automation = createPreviewAutomation(contents)
    const running = automation.execute('pick', { timeoutMs: 1_000 })
    await started
    debuggerApi.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 22 })
    await expect(running).resolves.toMatchObject({ selector: '#picked', tag: 'button', text: 'Continue' })
    expect(calls).toContainEqual({ method: 'DOM.resolveNode', params: { backendNodeId: 22 } })
    expect(calls.some(call => call.method === 'Overlay.setInspectMode' && call.params.mode === 'none')).toBe(true)
    automation.dispose()
  })

  it('waits for cancelled picker cleanup before starting the next operation', async () => {
    let inspectStarted!: () => void
    let cleanupStarted!: () => void
    let finishCleanup!: () => void
    const started = new Promise<void>(resolve => {
      inspectStarted = resolve
    })
    const cleaning = new Promise<void>(resolve => {
      cleanupStarted = resolve
    })
    const { contents, calls } = makeContents({
      sendCommand: async (method, params) => {
        if (method === 'Overlay.setInspectMode' && params.mode === 'searchForNode') inspectStarted()
        if (method === 'Overlay.disable') {
          cleanupStarted()
          await new Promise<void>(resolve => {
            finishCleanup = resolve
          })
        }
        return method === 'Runtime.evaluate' ? { result: { value: 42 } } : {}
      },
    })
    const automation = createPreviewAutomation(contents)
    const controller = new AbortController()
    const cancelled = automation.execute('pick', {}, controller.signal).catch(error => error)
    await started
    controller.abort()
    const next = automation.execute('evaluate', { expression: '42' })
    await cleaning
    expect(calls.some(call => call.method === 'Runtime.evaluate')).toBe(false)
    finishCleanup()
    expect(await cancelled).toBeInstanceOf(Error)
    await expect(next).resolves.toEqual({ value: 42 })
    automation.dispose()
  })

  it('cancels inspect mode on Escape', async () => {
    let inspectStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      inspectStarted = resolve
    })
    const { contents, contentsEvents, calls } = makeContents({
      sendCommand: async method => {
        if (method === 'Overlay.setInspectMode') inspectStarted?.()
        return {}
      },
    })
    const automation = createPreviewAutomation(contents)
    const running = automation.execute('pick', { timeoutMs: 1_000 })
    await started
    const event = { preventDefault: vi.fn() }
    contentsEvents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    await expect(running).rejects.toThrow('cancelled')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(calls.some(call => call.method === 'Overlay.setInspectMode' && call.params.mode === 'none')).toBe(true)
    automation.dispose()
  })
})
