import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient } from '@/shared/lib/application-rpc'

import type { ExportResult } from '../../../../shared/schemas/export.js'

export type ExportFormat = 'csv' | 'json'

export type ExportMachine =
  | { state: 'idle'; format: ExportFormat }
  | { state: 'exporting'; format: ExportFormat; requestId: number }
  | { state: 'succeeded'; format: ExportFormat; path: string }
  | { state: 'failed'; format: ExportFormat; message: string }

type ExportOutcome = { ok: true; data: ExportResult } | { ok: false; message: string }

export type ExportEvent =
  | { type: 'format-selected'; format: ExportFormat }
  | { type: 'started'; requestId: number }
  | { type: 'completed'; requestId: number; outcome: ExportOutcome }

export function selectExportFormat(machine: ExportMachine): ExportFormat {
  return machine.format
}

export function selectExporting(machine: ExportMachine): boolean {
  return machine.state === 'exporting'
}

export function selectExportMessage(machine: ExportMachine): { ok: boolean; text: string } | null {
  if (machine.state === 'succeeded') return { ok: true, text: `Exported to ${machine.path}.` }
  if (machine.state === 'failed') return { ok: false, text: machine.message }
  return null
}

export function transitionExport(machine: ExportMachine, event: ExportEvent): ExportMachine {
  switch (event.type) {
    case 'format-selected':
      if (machine.state === 'exporting' || machine.format === event.format) return machine
      return { state: 'idle', format: event.format }
    case 'started':
      if (machine.state === 'exporting') return machine
      return { state: 'exporting', format: machine.format, requestId: event.requestId }
    case 'completed':
      if (machine.state !== 'exporting' || machine.requestId !== event.requestId) return machine
      if (!event.outcome.ok) return { state: 'failed', format: machine.format, message: event.outcome.message }
      if (event.outcome.data.ok) {
        return { state: 'succeeded', format: machine.format, path: event.outcome.data.path }
      }
      if ('cancelled' in event.outcome.data) return { state: 'idle', format: machine.format }
      if ('error' in event.outcome.data) {
        return { state: 'failed', format: machine.format, message: event.outcome.data.error }
      }
      return { state: 'failed', format: machine.format, message: 'Export failed.' }
  }
}

type ExportClient = Pick<typeof ApplicationClient, 'runtime' | 'mutation'>

export const createExportAtoms = (client: ExportClient = ApplicationClient) => {
  const machineAtom = Atom.keepAlive(Atom.make<ExportMachine>({ state: 'idle', format: 'csv' }))
  let nextRequestId = 0

  const send = (get: Atom.FnContext, event: ExportEvent): void => {
    // Async command contexts retain their invocation snapshot; reducers need the live state.
    const current = get.registry.get(machineAtom)
    const next = transitionExport(current, event)
    if (next !== current) get.registry.set(machineAtom, next)
  }

  const selectFormatAtom = Atom.writable(
    get => get(machineAtom),
    (context, format: ExportFormat) => {
      const current = context.get(machineAtom)
      const next = transitionExport(current, { type: 'format-selected', format })
      if (next !== current) context.set(machineAtom, next)
    },
  )

  const exportMutation = client.mutation('export')
  const exportNowAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const requestId = ++nextRequestId
        send(get, { type: 'started', requestId })
        const machine = get.registry.get(machineAtom)
        if (machine.state !== 'exporting' || machine.requestId !== requestId) return

        const result = yield* Effect.result(get.setResult(exportMutation, { payload: { format: machine.format } }))
        send(
          get,
          result._tag === 'Success'
            ? { type: 'completed', requestId, outcome: { ok: true, data: result.success } }
            : {
                type: 'completed',
                requestId,
                outcome: { ok: false, message: 'Unable to reach the application.' },
              },
        )
      }),
    { concurrent: true },
  )

  return { machineAtom, selectFormatAtom, exportNowAtom }
}

const defaultExportAtoms = createExportAtoms()

export const {
  machineAtom: exportMachineAtom,
  selectFormatAtom: selectExportFormatAtom,
  exportNowAtom,
} = defaultExportAtoms
