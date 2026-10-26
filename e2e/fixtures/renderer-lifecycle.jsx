/* global document, window */
import { useAtomValue } from '@effect/atom-react'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { scanStateAtom } from '@/app/atoms/scan'
import { useAppBootstrap } from '@/app/hooks/use-app-bootstrap'
import { initializeRendererWindow, RendererRoot } from '@/app/renderer-root'
import { rendererRuntimeOwner } from '@/app/renderer-runtime'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'

const listeners = new Map()
const counts = {
  effectSetups: 0,
  effectCleanups: 0,
  scanCalls: 0,
  currencyReads: 0,
  attaches: 0,
  detaches: 0,
  rpcConnects: 0,
  lifecycleSubscriptions: 0,
  activeLifecycleSubscriptions: 0,
}
let nextGeneration = 1
const rpcMessages = new Map()
const rpcCloses = new Map()
const lifecycleRequests = new Map()
let scanned = false
const metadata = {
  scanId: 'fixture',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  portedFiles: 0,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [],
  aborted: false,
}
const lifecycleSnapshot = {
  _tag: 'Snapshot',
  role: 'app',
  state: {
    epoch: 'fixture-epoch',
    sequence: 0,
    ledgerGeneration: 0,
    configRevision: 0,
    scanStatus: { scanned: false },
    scanActivity: { scanning: false, progress: null, error: null },
    currency: { code: 'USD', symbol: '$', rate: 1 },
    updater: {
      revision: 0,
      currentVersion: 'fixture',
      latestVersion: null,
      updateAvailable: false,
      tag: null,
      phase: 'idle',
      installSupported: true,
      progress: null,
      message: null,
    },
    harnesses: [],
  },
}
const delay = value => new Promise(resolve => setTimeout(() => resolve(value), 15))
const subscribe = name => listener => {
  if (listeners.has(name)) throw new Error(`Duplicate event owner: ${name}`)
  counts.attaches++
  listeners.set(name, listener)
  return () => {
    counts.detaches++
    listeners.delete(name)
  }
}
window.api = {
  platform: 'win32',
  ...Object.fromEntries(
    [
      'onProgress',
      'onError',
      'onChanged',
      'onIdle',
      'onConfigChanged',
      'onCurrencyChanged',
      'onUpdateChanged',
      'onCoachEvent',
      'onCoachHarnessesChanged',
      'onNavigate',
    ].map(name => [name, subscribe(name)]),
  ),
  rpcV1: {
    connect: async () => {
      counts.rpcConnects++
      const generation = nextGeneration++
      rpcMessages.set(generation, new Set())
      rpcCloses.set(generation, new Set())
      return { _tag: 'Connected', generation }
    },
    send: async (frame, generation) => {
      const message = JSON.parse(frame)
      if (message._tag === 'Request' && message.tag === 'app:events') {
        counts.lifecycleSubscriptions++
        counts.activeLifecycleSubscriptions++
        lifecycleRequests.set(message.id, generation)
        const response = JSON.stringify({ _tag: 'Chunk', requestId: message.id, values: [lifecycleSnapshot] })
        for (const listener of rpcMessages.get(generation) ?? []) listener(response)
      } else if (message._tag === 'Interrupt' && lifecycleRequests.delete(message.requestId)) {
        counts.activeLifecycleSubscriptions--
      }
    },
    onMessage: (listener, generation) => {
      const listeners = rpcMessages.get(generation)
      listeners?.add(listener)
      return () => listeners?.delete(listener)
    },
    onClose: (listener, generation) => {
      const listeners = rpcCloses.get(generation)
      listeners?.add(listener)
      return () => listeners?.delete(listener)
    },
    disconnect: generation => {
      for (const [requestId, owner] of lifecycleRequests) {
        if (owner === generation) {
          lifecycleRequests.delete(requestId)
          counts.activeLifecycleSubscriptions--
        }
      }
      for (const listener of rpcCloses.get(generation) ?? []) listener()
      rpcMessages.delete(generation)
      rpcCloses.delete(generation)
    },
  },
  getScanStatus: () => delay({ scanned, ...(scanned ? { metadata } : {}) }),
  getScanActive: () => delay(false),
  getAnalytics: () => delay(null),
  getCadence: () => delay('1m'),
  getCurrency: () => {
    counts.currencyReads++
    return delay({ code: 'USD', symbol: '$', rate: 1 })
  },
  getCurrencies: () => delay([]),
  getUpdateStatus: () =>
    delay({
      revision: 0,
      phase: 'idle',
      currentVersion: 'fixture',
      latestVersion: null,
      updateAvailable: false,
      tag: null,
      installSupported: true,
      progress: null,
      message: null,
    }),
  scan: async () => {
    counts.scanCalls++
    if (listeners.size !== 9) throw new Error('Scan started before event subscription')
    scanned = true
    listeners.get('onChanged')(metadata)
    return await delay({ ok: true })
  },
}
const dispose = initializeRendererWindow(window)
const root = createRoot(document.getElementById('root'))

function Probe() {
  useAppBootstrap()
  const state = useAtomValue(scanStateAtom)
  const { formatUsd } = useCurrencyFormatter()
  useEffect(() => {
    counts.effectSetups++
    return () => {
      counts.effectCleanups++
    }
  }, [])
  return <div data-ready={state.hydrated}>{formatUsd(10)}</div>
}

window.lifecycleProbe = {
  counts,
  listeners: () => listeners.size,
  nodes: () => rendererRuntimeOwner.registry.getNodes().size,
  setCurrency: currency => listeners.get('onCurrencyChanged')(currency),
  dispose: () => {
    root.unmount()
    dispose()
    dispose()
  },
}
root.render(
  <StrictMode>
    <RendererRoot>
      <Probe />
    </RendererRoot>
  </StrictMode>,
)
