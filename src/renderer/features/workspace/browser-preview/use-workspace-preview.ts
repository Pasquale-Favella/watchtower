import { RegistryContext } from '@effect/atom-react'
import { type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { WorkspacePreviewConfigure } from '@/shared/rpc/workspace-preview.js'
import type {
  WorkspacePreviewAction,
  WorkspacePreviewOpen,
  WorkspacePreviewRef,
  WorkspacePreviewState,
} from '@/shared/schemas/workspace-preview.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import {
  adoptWorkspacePreviewAtom,
  cancelWorkspacePreviewPickAtom,
  captureWorkspacePreviewAtom,
  closeWorkspacePreviewAtom,
  commandWorkspacePreviewAtom,
  configureWorkspacePreviewAtom,
  describeWorkspacePreviewError,
  focusWorkspacePreviewAppAtom,
  layoutWorkspacePreviewAtom,
  navigateWorkspacePreviewAtom,
  pickWorkspacePreviewAtom,
  subscribeWorkspacePreview,
  workspacePreviewSessionAtom,
} from './preview-atoms.js'
import { browserPreviewStorage, readWorkspacePreviewUrl, rememberWorkspacePreviewUrl } from './preview-storage.js'

export function useWorkspacePreviewCommands() {
  const capture = useWorkspaceOperation(captureWorkspacePreviewAtom)
  const close = useWorkspaceOperation(closeWorkspacePreviewAtom)
  const adopt = useWorkspaceOperation(adoptWorkspacePreviewAtom)
  const configure = useWorkspaceOperation(configureWorkspacePreviewAtom)
  const pick = useWorkspaceOperation(pickWorkspacePreviewAtom)
  const cancelPick = useWorkspaceOperation(cancelWorkspacePreviewPickAtom)
  return {
    capture: (ownerKey: string, tabId: string) => capture({ ownerKey, tabId }),
    close: (ownerKey: string, tabId: string) => close({ ownerKey, tabId }),
    adopt: (ownerKey: string, nextOwnerKey: string) => adopt({ ownerKey, nextOwnerKey }),
    configure: (request: WorkspacePreviewConfigure) => configure(request),
    pick: (ownerKey: string, tabId: string) => pick({ ownerKey, tabId }),
    cancelPick: (ownerKey: string, tabId: string) => cancelPick({ ownerKey, tabId }),
  }
}

const BLOCKING_LAYERS =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[data-slot="popover-content"],[data-slot="dropdown-menu-content"],[data-slot="select-content"]'

/** Browser pages are native siblings of the renderer. App menus must hide them while open. */
export function workspacePreviewHasOverlay(host: HTMLElement): boolean {
  return [...document.querySelectorAll<HTMLElement>(BLOCKING_LAYERS)].some(layer => {
    if (
      layer.contains(host) ||
      layer.hidden ||
      layer.getAttribute('data-closed') !== null ||
      layer.getAttribute('aria-hidden') === 'true'
    )
      return false
    const bounds = layer.getBoundingClientRect()
    const style = getComputedStyle(layer)
    return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
}

export function useWorkspacePreview(
  request: WorkspacePreviewOpen,
  hostRef: RefObject<HTMLElement | null>,
  visible: boolean,
) {
  const registry = useContext(RegistryContext)
  const navigate = useWorkspaceOperation(navigateWorkspacePreviewAtom)
  const command = useWorkspaceOperation(commandWorkspacePreviewAtom)
  const layout = useWorkspaceOperation(layoutWorkspacePreviewAtom)
  const focusApp = useWorkspaceOperation(focusWorkspacePreviewAppAtom)
  const commandsRef = useRef({ navigate, command, layout, focusApp })
  const initialUrlRef = useRef(request.url ?? readWorkspacePreviewUrl(browserPreviewStorage(), request))
  const [settled, setSettled] = useState<{
    readonly identity: string
    readonly state: WorkspacePreviewState | null
    readonly error: string | null
  } | null>(null)
  const identity = JSON.stringify([request.ownerKey, request.tabId])
  const ref = useMemo<WorkspacePreviewRef>(
    () => ({ ownerKey: request.ownerKey, tabId: request.tabId }),
    [request.ownerKey, request.tabId],
  )

  useEffect(() => {
    commandsRef.current = { navigate, command, layout, focusApp }
  })
  useEffect(() => {
    const unsubscribe = subscribeWorkspacePreview(ref, event => {
      if ('_tag' in event)
        setSettled(current => ({
          identity,
          state: current?.identity === identity ? current.state : null,
          error: event.message,
        }))
      else {
        rememberWorkspacePreviewUrl(browserPreviewStorage(), ref, event.url)
        setSettled({ identity, state: event, error: null })
      }
    })
    const mountRequest = initialUrlRef.current ? { ...ref, url: initialUrlRef.current } : ref
    const unmount = registry.mount(workspacePreviewSessionAtom(mountRequest))
    return () => {
      unmount()
      unsubscribe()
    }
  }, [identity, ref, registry])

  const state = settled?.identity === identity ? settled.state : null
  const ready = Boolean(state && !state.closed)
  const pageAvailable = Boolean(state?.url && !state.error)
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready) return
    let previous = ''
    let frame = 0
    const update = () => {
      frame = 0
      const rect = host.getBoundingClientRect()
      const bounds = {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      }
      const shown =
        visible && pageAvailable && document.visibilityState !== 'hidden' && !workspacePreviewHasOverlay(host)
      const next = JSON.stringify([bounds, shown])
      if (next === previous) return
      previous = next
      void commandsRef.current.layout({ ...ref, bounds, visible: shown }).catch(() => undefined)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(host)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-open', 'data-closed', 'data-state', 'hidden', 'aria-hidden', 'class', 'style'],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    update()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      void commandsRef.current
        .layout({ ...ref, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false })
        .catch(() => undefined)
    }
  }, [hostRef, pageAvailable, ready, ref, visible])

  const navigateTo = useCallback((url: string) => commandsRef.current.navigate({ ...ref, url }), [ref])
  const perform = useCallback(
    (action: WorkspacePreviewAction) => commandsRef.current.command({ ...ref, action }),
    [ref],
  )
  return {
    state,
    error: settled?.identity === identity ? settled.error : null,
    navigate: navigateTo,
    command: perform,
    focusApp: () => commandsRef.current.focusApp(ref),
    describeError: describeWorkspacePreviewError,
  }
}
