/* global document, window */
import { useAtomValue } from '@effect/atom-react'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { appLifecycleReadinessAtom } from '@/app/atoms/rpc-lifecycle'
import { scanStateAtom } from '@/app/atoms/scan'
import { appBootstrapAtom } from '@/app/hooks/use-app-bootstrap'
import { useAppBootstrap } from '@/app/hooks/use-app-bootstrap'
import { initializeRendererWindow, RendererRoot } from '@/app/renderer-root'
import { rendererRuntimeOwner } from '@/app/renderer-runtime'
import { navigationReadinessAtom } from '@/app/stores/subscribe'
import { AboutSection } from '@/features/settings/AboutSection'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'

const counts = {
  effectSetups: 0,
  effectCleanups: 0,
  scanCalls: 0,
  nativeReads: {},
  unexpectedRequests: [],
  attaches: 0,
  detaches: 0,
  rpcConnects: 0,
  lifecycleSubscriptions: 0,
  activeLifecycleSubscriptions: 0,
  shellSubscriptions: 0,
  activeShellSubscriptions: 0,
}
let nextGeneration = 1
const rpcMessages = new Map()
const rpcCloses = new Map()
const lifecycleRequests = new Map()
const shellRequests = new Map()
let scanned = false
let lifecycleSequence = 0
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
  },
}
const delay = value => new Promise(resolve => setTimeout(() => resolve(value), 15))
const currency = { code: 'USD', symbol: '$', rate: 1 }
/** @type {import('../../src/shared/rpc/shell').ShellEvent} */
const shellReadyEvent = { _tag: 'Ready', placement: null }
const updateStatus = {
  revision: 0,
  currentVersion: 'fixture',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'unsupported',
  installSupported: false,
  progress: null,
  message: null,
}
let setUpdatesVisible = () => {}
const reply = (generation, frame) => {
  const message = JSON.stringify(frame)
  for (const listener of rpcMessages.get(generation) ?? []) listener(message)
}
const publishLifecycle = event => {
  lifecycleSequence++
  for (const [requestId, generation] of lifecycleRequests) {
    reply(generation, {
      _tag: 'Chunk',
      requestId,
      values: [
        {
          _tag: 'Event',
          envelope: {
            epoch: 'fixture-epoch',
            sequence: lifecycleSequence,
            ledgerGeneration: 0,
            configRevision: 0,
            event,
          },
        },
      ],
    })
  }
}
const publishShellEvent = event => {
  for (const [requestId, generation] of shellRequests) {
    reply(generation, {
      _tag: 'Chunk',
      requestId,
      values: [event],
    })
  }
}
const readNative = async (tag, request, generation) => {
  counts.nativeReads[tag] = (counts.nativeReads[tag] ?? 0) + 1
  let value
  switch (tag) {
    case 'store:status':
      value = { scanned, ...(scanned ? { metadata } : {}) }
      break
    case 'scan:active':
      value = false
      break
    case 'scan:start':
      if (request.payload && Object.keys(request.payload).length > 0) throw new Error('Unexpected scan:start payload')
      if (lifecycleRequests.size !== 1) throw new Error('Scan started before native lifecycle subscription')
      counts.scanCalls++
      scanned = true
      publishLifecycle({ _tag: 'StoreChanged', metadata })
      value = { ok: true }
      break
    case 'store:analytics':
      value = null
      break
    case 'cadence:get':
      value = '1m'
      break
    case 'currency:get':
      value = currency
      break
    case 'currency:list':
      value = []
      break
    case 'updates:status':
      value = updateStatus
      break
    case 'coach:harnesses':
      value = []
      break
    default:
      counts.unexpectedRequests.push(tag)
      throw new Error(`Unexpected native RPC request: ${tag}`)
  }
  await delay(undefined)
  reply(generation, {
    _tag: 'Exit',
    requestId: request.id,
    exit: { _tag: 'Success', value },
  })
}
window.api = {
  platform: 'win32',
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
      if (message._tag === 'Request') {
        if (message.tag === 'app:events') {
          counts.lifecycleSubscriptions++
          counts.activeLifecycleSubscriptions++
          lifecycleRequests.set(message.id, generation)
          await delay(undefined)
          reply(generation, { _tag: 'Chunk', requestId: message.id, values: [lifecycleSnapshot] })
          return
        }
        if (message.tag === 'shell:events') {
          counts.nativeReads[message.tag] = (counts.nativeReads[message.tag] ?? 0) + 1
          counts.shellSubscriptions++
          counts.activeShellSubscriptions++
          shellRequests.set(message.id, generation)
          await delay(undefined)
          publishShellEvent(shellReadyEvent)
          return
        }
        await readNative(message.tag, message, generation)
      } else if (message._tag === 'Interrupt') {
        if (lifecycleRequests.delete(message.requestId)) counts.activeLifecycleSubscriptions--
        if (shellRequests.delete(message.requestId)) counts.activeShellSubscriptions--
      } else {
        if (message._tag === 'Ping') reply(generation, { _tag: 'Pong' })
      }
    },
    onMessage: (listener, generation) => {
      const generationListeners = rpcMessages.get(generation)
      if (generationListeners && !generationListeners.has(listener)) {
        generationListeners.add(listener)
        counts.attaches++
      }
      let subscribed = generationListeners?.has(listener) ?? false
      return () => {
        if (!subscribed) return
        subscribed = false
        if (generationListeners?.delete(listener)) counts.detaches++
      }
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
      for (const [requestId, owner] of shellRequests) {
        if (owner === generation) {
          shellRequests.delete(requestId)
          counts.activeShellSubscriptions--
        }
      }
      const messageListeners = rpcMessages.get(generation)
      if (messageListeners) {
        counts.detaches += messageListeners.size
        messageListeners.clear()
      }
      for (const listener of rpcCloses.get(generation) ?? []) listener()
      rpcMessages.delete(generation)
      rpcCloses.delete(generation)
    },
  },
}
const dispose = initializeRendererWindow(window)
const root = createRoot(document.getElementById('root'))

function Probe() {
  useAppBootstrap()
  const [updatesVisible, setVisible] = useState(false)
  setUpdatesVisible = setVisible
  const state = useAtomValue(scanStateAtom)
  const { formatUsd } = useCurrencyFormatter()
  useEffect(() => {
    counts.effectSetups++
    return () => {
      counts.effectCleanups++
    }
  }, [])
  counts.renderCount = (counts.renderCount ?? 0) + 1
  counts.lastRenderedScan = state
  return (
    <>
      <div data-ready={state.hydrated}>{formatUsd(10)}</div>
      {updatesVisible && <AboutSection />}
    </>
  )
}

window.lifecycleProbe = {
  counts,
  listeners: () =>
    Array.from(rpcMessages.values()).reduce((total, generationListeners) => total + generationListeners.size, 0),
  nodes: () => rendererRuntimeOwner.registry.getNodes().size,
  diagnostics: () => ({
    counts,
    scan: rendererRuntimeOwner.registry.get(scanStateAtom),
    readiness: rendererRuntimeOwner.registry.get(appLifecycleReadinessAtom),
    navigationReadiness: rendererRuntimeOwner.registry.get(navigationReadinessAtom),
    bootstrap: rendererRuntimeOwner.registry.get(appBootstrapAtom),
  }),
  setCurrency: nextCurrency => publishLifecycle({ _tag: 'CurrencyChanged', currency: nextCurrency }),
  showUpdatesPane: () => setUpdatesVisible(true),
  hideUpdatesPane: () => setUpdatesVisible(false),
  publishUpdate: status => publishLifecycle({ _tag: 'UpdateChanged', status }),
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
