import { create } from 'zustand'

import { type ApiResult, fetchExport } from '@/shared/lib/api'

import type { ExportResult } from '../../../../shared/schemas/export.js'

export type ExportFormat = 'csv' | 'json'

export type ExportMachine =
  | { state: 'idle'; format: ExportFormat }
  | { state: 'exporting'; format: ExportFormat; requestId: number }
  | { state: 'succeeded'; format: ExportFormat; path: string }
  | { state: 'failed'; format: ExportFormat; message: string }

export type ExportEvent =
  | { type: 'format-selected'; format: ExportFormat }
  | { type: 'started'; requestId: number }
  | { type: 'completed'; requestId: number; outcome: ApiResult<ExportResult> }
  | { type: 'thrown'; requestId: number; message: string }

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
      if (!event.outcome.ok) {
        return { state: 'failed', format: machine.format, message: event.outcome.error ?? 'Export failed.' }
      }
      if (event.outcome.data.ok) {
        return { state: 'succeeded', format: machine.format, path: event.outcome.data.path }
      }
      if ('cancelled' in event.outcome.data) return { state: 'idle', format: machine.format }
      if ('error' in event.outcome.data) {
        return { state: 'failed', format: machine.format, message: event.outcome.data.error }
      }
      return { state: 'failed', format: machine.format, message: 'Export failed.' }
    case 'thrown':
      if (machine.state !== 'exporting' || machine.requestId !== event.requestId) return machine
      return { state: 'failed', format: machine.format, message: event.message }
  }
}

export interface ExportStore {
  machine: ExportMachine
  selectFormat: (format: ExportFormat) => void
  exportNow: () => Promise<void>
}

export const useExportStore = create<ExportStore>()((set, get) => {
  let nextRequestId = 0

  function send(event: ExportEvent): void {
    set(current => {
      const machine = transitionExport(current.machine, event)
      return machine === current.machine ? current : { machine }
    })
  }

  return {
    machine: { state: 'idle', format: 'csv' },
    selectFormat: format => send({ type: 'format-selected', format }),
    exportNow: async () => {
      const requestId = ++nextRequestId
      send({ type: 'started', requestId })
      const machine = get().machine
      if (machine.state !== 'exporting' || machine.requestId !== requestId) return

      try {
        const outcome = await fetchExport(machine.format)
        send({ type: 'completed', requestId, outcome })
      } catch (error) {
        send({
          type: 'thrown',
          requestId,
          message: error instanceof Error ? error.message : 'Export failed.',
        })
      }
    },
  }
})
