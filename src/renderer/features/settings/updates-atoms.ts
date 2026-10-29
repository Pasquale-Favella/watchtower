import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'

import { createRpcQuerySlot } from '@/stores/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'

import type { UpdateStatus } from '../../../shared/schemas/updates.js'

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

export type UpdatesMachine =
  | { state: 'uninitialized' }
  | { state: 'loading'; requestId: number }
  | { state: 'load-error'; message: string }
  | { state: 'synced'; status: UpdateStatus }
  | { state: 'requesting'; status: UpdateStatus; command: UpdateCommand; requestId: number }
  | { state: 'request-error'; status: UpdateStatus; message: string }

type UpdateResult = { ok: true; status: UpdateStatus } | { ok: false; message: string }

type UpdatesEvent =
  | { type: 'load'; requestId: number }
  | { type: 'loaded'; requestId: number; result: UpdateResult }
  | { type: 'request'; requestId: number; command: UpdateCommand }
  | { type: 'completed'; requestId: number; result: UpdateResult }
  | { type: 'status-changed'; status: UpdateStatus }

export function selectUpdateStatus(machine: UpdatesMachine): UpdateStatus | null {
  return 'status' in machine ? machine.status : null
}

export function selectUpdateError(machine: UpdatesMachine): string | null {
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

export function transitionUpdates(machine: UpdatesMachine, event: UpdatesEvent): UpdatesMachine {
  switch (event.type) {
    case 'load':
      if (machine.state !== 'uninitialized' && machine.state !== 'load-error') return machine
      return { state: 'loading', requestId: event.requestId }
    case 'loaded':
      if (machine.state !== 'loading' || machine.requestId !== event.requestId) return machine
      if (event.result.ok) return { state: 'synced', status: event.result.status }
      return { state: 'load-error', message: 'Unable to read update status. Try again or open the release page.' }
    case 'request':
      if (!canRequestUpdate(machine, event.command) || !('status' in machine)) return machine
      return { state: 'requesting', status: machine.status, command: event.command, requestId: event.requestId }
    case 'completed':
      if (machine.state !== 'requesting' || machine.requestId !== event.requestId) return machine
      if (event.result.ok) return { state: 'synced', status: newerStatus(machine.status, event.result.status) }
      return {
        state: 'request-error',
        status: machine.status,
        message: 'The update request failed. Try again or open the release page.',
      }
    case 'status-changed': {
      const current = selectUpdateStatus(machine)
      if (current && event.status.revision <= current.revision) return machine
      if (machine.state === 'requesting') return { ...machine, status: event.status }
      return { state: 'synced', status: event.status }
    }
  }
}

type UpdatesClient = Pick<typeof ApplicationClient, 'runtime' | 'mutation' | 'query'>
const UPDATE_STATUS_REQUEST = {}

export const createUpdatesAtoms = (client: UpdatesClient = ApplicationClient) => {
  const machineAtom = Atom.keepAlive(Atom.make<UpdatesMachine>({ state: 'uninitialized' }))
  let nextRequestId = 0
  const statusQuery = createRpcQuerySlot({
    key: () => 'updates-status',
    query: (_request: typeof UPDATE_STATUS_REQUEST, selectionId) =>
      client.query('updates:status', undefined, { serializationKey: selectionId }),
  })

  const send = (get: Atom.FnContext, event: UpdatesEvent): void => {
    // Async command contexts retain their invocation snapshot; reducers need the live state.
    const current = get.registry.get(machineAtom)
    const next = transitionUpdates(current, event)
    if (next !== current) get.registry.set(machineAtom, next)
  }

  const loadUpdateStatusAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const requestId = ++nextRequestId
        send(get, { type: 'load', requestId })
        const machine = get.registry.get(machineAtom)
        if (machine.state !== 'loading' || machine.requestId !== requestId) return

        get.registry.set(statusQuery.resetAtom, undefined)
        get.registry.set(statusQuery.requestAtom, UPDATE_STATUS_REQUEST)
        const result = yield* Effect.result(get.result(statusQuery.resultAtom, { suspendOnWaiting: true }))
        send(
          get,
          result._tag === 'Success'
            ? { type: 'loaded', requestId, result: { ok: true, status: result.success } }
            : { type: 'loaded', requestId, result: { ok: false, message: result.failure.message } },
        )
      }),
    { concurrent: true },
  )

  const mutations = {
    check: client.mutation('updates:check'),
    download: client.mutation('updates:download'),
    install: client.mutation('updates:install'),
  }

  const makeCommandAtom = (command: UpdateCommand) =>
    client.runtime.fn<undefined>()(
      (_, get) =>
        Effect.gen(function* () {
          const requestId = ++nextRequestId
          send(get, { type: 'request', requestId, command })
          const machine = get.registry.get(machineAtom)
          if (machine.state !== 'requesting' || machine.requestId !== requestId) return

          const result = yield* Effect.result(get.setResult(mutations[command], { payload: undefined }))
          send(
            get,
            result._tag === 'Success'
              ? { type: 'completed', requestId, result: { ok: true, status: result.success } }
              : { type: 'completed', requestId, result: { ok: false, message: result.failure.message } },
          )
        }),
      { concurrent: true },
    )

  const statusChangedAtom = Atom.writable(
    get => get(machineAtom),
    (context, status: UpdateStatus) => {
      const current = context.get(machineAtom)
      const next = transitionUpdates(current, { type: 'status-changed', status })
      if (next !== current) context.set(machineAtom, next)
    },
  )

  return {
    machineAtom,
    loadUpdateStatusAtom,
    checkForUpdatesAtom: makeCommandAtom('check'),
    downloadUpdateAtom: makeCommandAtom('download'),
    installUpdateAtom: makeCommandAtom('install'),
    statusChangedAtom,
  }
}

const defaultUpdatesAtoms = createUpdatesAtoms()

export const {
  machineAtom: updatesMachineAtom,
  loadUpdateStatusAtom,
  checkForUpdatesAtom,
  downloadUpdateAtom,
  installUpdateAtom,
  statusChangedAtom: updateStatusChangedAtom,
} = defaultUpdatesAtoms
