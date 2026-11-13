import { RegistryContext } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  type WorkspaceDevice,
  type WorkspaceDeviceAction,
  type WorkspaceDeviceList,
  type WorkspaceDeviceRef,
  workspaceDeviceRefSchema,
  type WorkspaceDeviceScreenshot,
} from '@/shared/schemas/workspace-devices.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import {
  actionWorkspaceDeviceAtom,
  bootWorkspaceDeviceAtom,
  connectWorkspaceDeviceAtom,
  installWorkspaceDeviceAtom,
  listWorkspaceDevicesAtom,
  screenshotWorkspaceDeviceAtom,
  shutdownWorkspaceDeviceAtom,
  subscribeWorkspaceDeviceFrames,
  workspaceDeviceErrorMessage,
  workspaceDeviceFrameAtom,
} from './device-atoms.js'

function readSelected(key: string): WorkspaceDeviceRef | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw
      ? Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(workspaceDeviceRefSchema))(raw))
      : null
  } catch {
    return null
  }
}

export function useWorkspaceDevices(ownerKey: string, tabId: string, visible: boolean) {
  const storageKey = `watchtower.workspace.device.v1:${JSON.stringify([ownerKey, tabId])}`
  const [selection, setSelection] = useState(() => readSelected(storageKey))
  const [listing, setListing] = useState<WorkspaceDeviceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const list = useWorkspaceOperation(listWorkspaceDevicesAtom)
  const boot = useWorkspaceOperation(bootWorkspaceDeviceAtom)
  const shutdown = useWorkspaceOperation(shutdownWorkspaceDeviceAtom)
  const action = useWorkspaceOperation(actionWorkspaceDeviceAtom)
  const install = useWorkspaceOperation(installWorkspaceDeviceAtom)
  const connect = useWorkspaceOperation(connectWorkspaceDeviceAtom)
  const commands = useRef({ list, boot, shutdown, action, install, connect })
  const lock = useRef(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    commands.current = { list, boot, shutdown, action, install, connect }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    try {
      const result = await commands.current.list(undefined)
      if (mounted.current) {
        setListing(result)
        setListError(null)
      }
    } catch (cause) {
      if (mounted.current) setListError(workspaceDeviceErrorMessage(cause))
    }
  }, [])
  useEffect(() => {
    if (!visible) return
    void refresh()
    const timer = setInterval(() => {
      if (!lock.current) void refresh()
    }, 5000)
    return () => clearInterval(timer)
  }, [refresh, visible])
  const select = (device: WorkspaceDevice | null) => {
    const ref = device ? { platform: device.platform, id: device.id } : null
    setSelection(ref)
    setSelectedName(device?.name ?? null)
    try {
      if (ref) window.localStorage.setItem(storageKey, JSON.stringify(ref))
      else window.localStorage.removeItem(storageKey)
    } catch {
      /* The selected device still works without stored preferences. */
    }
  }
  const selected =
    listing?.devices.find(device => device.platform === selection?.platform && device.id === selection.id) ??
    listing?.devices.find(
      device => device.platform === selection?.platform && device.name === selectedName && device.state === 'booted',
    ) ??
    null
  const run = async (operation: () => Promise<unknown>, refreshAfter: boolean) => {
    if (lock.current) return false
    lock.current = true
    setPending(true)
    setError(null)
    try {
      await operation()
      if (refreshAfter) await refresh()
      return true
    } catch (cause) {
      if (mounted.current) setError(workspaceDeviceErrorMessage(cause))
      return false
    } finally {
      lock.current = false
      if (mounted.current) setPending(false)
    }
  }
  return {
    listing,
    selected,
    selection,
    select,
    error: error ?? listError,
    pending,
    refresh,
    connect: (address: string) => run(() => commands.current.connect({ address }), true),
    boot: () => selected && run(() => commands.current.boot(selected), true),
    shutdown: () => selected && run(() => commands.current.shutdown(selected), true),
    install: () => selected && run(() => commands.current.install(selected), true),
    action: (request: WorkspaceDeviceAction) => run(() => commands.current.action(request), false),
  }
}

export function useWorkspaceDeviceFrame(device: WorkspaceDevice | null, visible: boolean) {
  const registry = useContext(RegistryContext)
  const screenshot = useWorkspaceOperation(screenshotWorkspaceDeviceAtom)
  const screenshotRef = useRef(screenshot)
  useEffect(() => {
    screenshotRef.current = screenshot
  })
  const [settled, setSettled] = useState<{
    readonly identity: string
    readonly frame: WorkspaceDeviceScreenshot | null
    readonly error: string | null
  } | null>(null)
  const platform = device?.platform
  const deviceId = device?.id
  const ref = useMemo<WorkspaceDeviceRef | null>(
    () => (platform && deviceId ? { platform, id: deviceId } : null),
    [platform, deviceId],
  )
  const identity = ref ? JSON.stringify(ref) : ''
  const ready = Boolean(device?.capabilities.screenshot && visible)
  useEffect(() => {
    if (!ref || !ready) return
    const unsubscribe = subscribeWorkspaceDeviceFrames(ref, event =>
      setSettled(current => ({
        identity,
        frame: event.frame ?? (current?.identity === identity ? current.frame : null),
        error: event.error,
      })),
    )
    const unmount = registry.mount(workspaceDeviceFrameAtom(ref))
    return () => {
      unmount()
      unsubscribe()
    }
  }, [identity, ready, ref, registry])
  const refresh = useCallback(async () => {
    if (!ref) return
    try {
      const frame = await screenshotRef.current(ref)
      setSettled({ identity, frame, error: null })
    } catch (cause) {
      setSettled(current => ({
        identity,
        frame: current?.identity === identity ? current.frame : null,
        error: workspaceDeviceErrorMessage(cause),
      }))
    }
  }, [identity, ref])
  return {
    frame: settled?.identity === identity ? settled.frame : null,
    error: settled?.identity === identity ? settled.error : null,
    refresh,
  }
}
