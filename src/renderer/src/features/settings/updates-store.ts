import { create } from 'zustand'

import {
  type ApiResult,
  fetchCheckForUpdates,
  fetchDownloadUpdate,
  fetchInstallUpdate,
  fetchUpdateStatus,
} from '@/shared/lib/api'

import type { UpdateStatus } from '../../../../shared/schemas/updates.js'

type UpdateCommand = 'check' | 'download' | 'install'

const phasePolicy: Record<
  UpdateStatus['phase'],
  { commands: readonly UpdateCommand[]; activity: UpdateCommand | null }
> = {
  idle: { commands: ['check'], activity: null },
  unsupported: { commands: [], activity: null },
  checking: { commands: [], activity: 'check' },
  current: { commands: ['check'], activity: null },
  available: { commands: ['check', 'download'], activity: null },
  downloading: { commands: [], activity: 'download' },
  ready: { commands: ['install'], activity: null },
  installing: { commands: [], activity: 'install' },
  error: { commands: ['check', 'download'], activity: null },
}

/** Main owns installation. This machine owns hydration and user requests. */
type UpdatesMachine =
  | { state: 'uninitialized' }
  | { state: 'loading'; requestId: number }
  | { state: 'load-error'; message: string }
  | { state: 'synced'; status: UpdateStatus }
  | { state: 'requesting'; status: UpdateStatus; command: UpdateCommand; requestId: number }
  | { state: 'request-error'; status: UpdateStatus; message: string }

type UpdatesEvent =
  | { type: 'load'; requestId: number }
  | { type: 'loaded'; requestId: number; result: ApiResult<UpdateStatus> }
  | { type: 'request'; requestId: number; command: UpdateCommand }
  | { type: 'completed'; requestId: number; result: ApiResult<UpdateStatus> }
  | { type: 'status-changed'; status: UpdateStatus }

export function selectUpdateStatus(machine: UpdatesMachine): UpdateStatus | null {
  return 'status' in machine ? machine.status : null
}

export function selectUpdateError(machine: UpdatesMachine): string | null {
  // Renderer hydration/IPC failures. Updater failures remain in status.message.
  return 'message' in machine ? machine.message : null
}

export function selectUpdateActivity(machine: UpdatesMachine): UpdateCommand | null {
  if (machine.state === 'requesting') return machine.command
  const status = selectUpdateStatus(machine)
  return status ? phasePolicy[status.phase].activity : null
}

function isCommandAvailable(status: UpdateStatus | null, command: UpdateCommand): boolean {
  if (!status?.installSupported) return false
  return phasePolicy[status.phase].commands.includes(command) && (command !== 'download' || status.updateAvailable)
}

/** Keep an available action visible while its renderer request is pending. */
export function selectUpdateCommandVisible(machine: UpdatesMachine, command: 'download' | 'install'): boolean {
  return isCommandAvailable(selectUpdateStatus(machine), command)
}

export function canRequestUpdate(machine: UpdatesMachine, command: UpdateCommand): boolean {
  if (machine.state !== 'synced' && machine.state !== 'request-error') return false
  return isCommandAvailable(machine.status, command)
}

function newerStatus(current: UpdateStatus, incoming: UpdateStatus): UpdateStatus {
  return incoming.revision > current.revision ? incoming : current
}

function transitionUpdates(machine: UpdatesMachine, event: UpdatesEvent): UpdatesMachine {
  switch (event.type) {
    case 'load':
      if (machine.state !== 'uninitialized' && machine.state !== 'load-error') return machine
      return { state: 'loading', requestId: event.requestId }
    case 'loaded':
      if (machine.state !== 'loading' || machine.requestId !== event.requestId) return machine
      if (event.result.ok) return { state: 'synced', status: event.result.data }
      return { state: 'load-error', message: 'Unable to read update status. Try again or open the release page.' }
    case 'request':
      if (!canRequestUpdate(machine, event.command) || !('status' in machine)) return machine
      return { state: 'requesting', status: machine.status, command: event.command, requestId: event.requestId }
    case 'completed': {
      if (machine.state !== 'requesting' || machine.requestId !== event.requestId) return machine
      if (event.result.ok) return { state: 'synced', status: newerStatus(machine.status, event.result.data) }
      return {
        state: 'request-error',
        status: machine.status,
        message: 'The update request failed. Try again or open the release page.',
      }
    }
    case 'status-changed': {
      const current = selectUpdateStatus(machine)
      if (current && event.status.revision <= current.revision) return machine
      if (machine.state === 'requesting') return { ...machine, status: event.status }
      return { state: 'synced', status: event.status }
    }
  }
}

export interface UpdatesStore {
  machine: UpdatesMachine
  load: () => Promise<void>
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  onStatus: (status: UpdateStatus) => void
}

const commands = {
  check: fetchCheckForUpdates,
  download: fetchDownloadUpdate,
  install: fetchInstallUpdate,
}

/** Transient app-window state, hydrated and subscribed at the composition root. */
export const useUpdatesStore = create<UpdatesStore>()((set, get) => {
  let nextRequestId = 0

  function send(event: UpdatesEvent): void {
    set(current => {
      const machine = transitionUpdates(current.machine, event)
      return machine === current.machine ? current : { machine }
    })
  }

  async function request(command: UpdateCommand): Promise<void> {
    const requestId = ++nextRequestId
    send({ type: 'request', requestId, command })
    const machine = get().machine
    if (machine.state !== 'requesting' || machine.requestId !== requestId) return
    const result = await commands[command]()
    send({ type: 'completed', requestId, result })
  }

  return {
    machine: { state: 'uninitialized' },
    load: async () => {
      const requestId = ++nextRequestId
      send({ type: 'load', requestId })
      const machine = get().machine
      if (machine.state !== 'loading' || machine.requestId !== requestId) return
      const result = await fetchUpdateStatus()
      send({ type: 'loaded', requestId, result })
    },
    check: () => request('check'),
    download: () => request('download'),
    install: () => request('install'),
    onStatus: status => send({ type: 'status-changed', status }),
  }
})
