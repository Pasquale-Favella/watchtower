import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchExport } = vi.hoisted(() => ({ mockFetchExport: vi.fn() }))

vi.mock('@/shared/lib/api', () => ({ fetchExport: mockFetchExport }))

import {
  type ExportMachine,
  selectExportFormat,
  selectExporting,
  selectExportMessage,
  transitionExport,
  useExportStore,
} from '../src/renderer/src/features/settings/export-store.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  useExportStore.setState(useExportStore.getInitialState(), true)
  mockFetchExport.mockReset()
})

describe('export state machine', () => {
  it('starts idle with CSV selected', () => {
    expect(useExportStore.getState().machine).toEqual({ state: 'idle', format: 'csv' })
    expect(selectExportFormat(useExportStore.getState().machine)).toBe('csv')
    expect(selectExporting(useExportStore.getState().machine)).toBe(false)
    expect(selectExportMessage(useExportStore.getState().machine)).toBeNull()
  })

  it('moves to exporting and reports the successful path', () => {
    const exporting = transitionExport({ state: 'idle', format: 'json' }, { type: 'started', requestId: 12 })
    expect(exporting).toEqual({ state: 'exporting', format: 'json', requestId: 12 })

    const succeeded = transitionExport(exporting, {
      type: 'completed',
      requestId: 12,
      outcome: { ok: true, data: { ok: true, path: 'C:\\exports\\usage.json' } },
    })
    expect(succeeded).toEqual({ state: 'succeeded', format: 'json', path: 'C:\\exports\\usage.json' })
    expect(selectExportMessage(succeeded)).toEqual({ ok: true, text: 'Exported to C:\\exports\\usage.json.' })
    expect(selectExportFormat(succeeded)).toBe('json')
    expect(selectExporting(succeeded)).toBe(false)
  })

  it('clears a result when the selected format changes', () => {
    const failed: ExportMachine = { state: 'failed', format: 'csv', message: 'Disk full.' }
    expect(transitionExport(failed, { type: 'format-selected', format: 'json' })).toEqual({
      state: 'idle',
      format: 'json',
    })
  })

  it('ignores format changes while an export is in flight', () => {
    const exporting: ExportMachine = { state: 'exporting', format: 'csv', requestId: 4 }
    expect(transitionExport(exporting, { type: 'format-selected', format: 'json' })).toBe(exporting)
  })

  it('returns to idle silently when the save dialog is cancelled', () => {
    const exporting: ExportMachine = { state: 'exporting', format: 'csv', requestId: 5 }
    const cancelled = transitionExport(exporting, {
      type: 'completed',
      requestId: 5,
      outcome: { ok: true, data: { ok: false, cancelled: true } },
    })
    expect(cancelled).toEqual({ state: 'idle', format: 'csv' })
    expect(selectExportMessage(cancelled)).toBeNull()
  })

  it('maps transport failures and returned export errors to failed messages', () => {
    const exporting: ExportMachine = { state: 'exporting', format: 'csv', requestId: 7 }
    const transportFailure = transitionExport(exporting, {
      type: 'completed',
      requestId: 7,
      outcome: { ok: false, error: 'IPC unavailable' },
    })
    expect(transportFailure).toEqual({ state: 'failed', format: 'csv', message: 'IPC unavailable' })

    const exportFailure = transitionExport(exporting, {
      type: 'completed',
      requestId: 7,
      outcome: { ok: true, data: { ok: false, error: 'Permission denied' } },
    })
    expect(exportFailure).toEqual({ state: 'failed', format: 'csv', message: 'Permission denied' })
  })

  it('uses the fallback when a transport failure has no message', () => {
    const failed = transitionExport(
      { state: 'exporting', format: 'json', requestId: 8 },
      { type: 'completed', requestId: 8, outcome: { ok: false } as { ok: false; error: string } },
    )
    expect(failed).toEqual({ state: 'failed', format: 'json', message: 'Export failed.' })
  })

  it('ignores a completion from a stale request ID', () => {
    const current: ExportMachine = { state: 'exporting', format: 'json', requestId: 10 }
    expect(
      transitionExport(current, {
        type: 'completed',
        requestId: 9,
        outcome: { ok: true, data: { ok: true, path: 'old.json' } },
      }),
    ).toBe(current)
  })
})

describe('useExportStore', () => {
  it('does not start a second export while one is in flight', async () => {
    const request = deferred<unknown>()
    mockFetchExport.mockReturnValue(request.promise)

    const first = useExportStore.getState().exportNow()
    const second = useExportStore.getState().exportNow()
    expect(mockFetchExport).toHaveBeenCalledTimes(1)
    expect(useExportStore.getState().machine).toMatchObject({ state: 'exporting', format: 'csv' })

    request.resolve({ ok: true, data: { ok: false, cancelled: true } })
    await Promise.all([first, second])
    expect(useExportStore.getState().machine).toEqual({ state: 'idle', format: 'csv' })
  })

  it('passes the selected format and surfaces a thrown fetch error', async () => {
    mockFetchExport.mockRejectedValue(new Error('IPC crashed'))
    useExportStore.getState().selectFormat('json')

    await useExportStore.getState().exportNow()

    expect(mockFetchExport).toHaveBeenCalledWith('json')
    expect(useExportStore.getState().machine).toEqual({ state: 'failed', format: 'json', message: 'IPC crashed' })
  })

  it('uses the fallback message for a non-Error thrown value', async () => {
    mockFetchExport.mockRejectedValue('unexpected failure')

    await useExportStore.getState().exportNow()

    expect(useExportStore.getState().machine).toEqual({ state: 'failed', format: 'csv', message: 'Export failed.' })
  })
})
