import * as Effect from 'effect/Effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'

import type { NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import {
  createExportAtoms,
  type ExportMachine,
  selectExportFormat,
  selectExporting,
  selectExportMessage,
  transitionExport,
} from '../src/renderer/features/settings/export-atoms.js'
import type { ExportResult } from '../src/shared/schemas/export.js'
import { makeSettingsRpcTestClient } from './settings-rpc-test-helper.js'

function makeHarness(exportData: NativeRpcCapabilities['exportData']) {
  const runtime = Atom.context()
  const client = makeSettingsRpcTestClient(
    runtime,
    async () => {
      throw new Error('Unexpected worker operation in an export test')
    },
    { exportData },
  )
  const atoms = createExportAtoms(client)
  const registry = AtomRegistry.make()
  return { atoms, registry }
}

function dispatch<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Promise<AsyncResult.AsyncResult<A, E>> {
  return new Promise(resolve => {
    let unsubscribe: () => void = () => undefined
    unsubscribe = registry.subscribe(atom, result => {
      if (!result.waiting && !AsyncResult.isInitial(result)) {
        unsubscribe()
        resolve(result)
      }
    })
    registry.set(atom, arg)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('native export atoms', () => {
  it('starts idle with CSV selected', () => {
    const { atoms, registry } = makeHarness(() => Effect.succeed({ ok: true, path: 'export.csv' }))
    const machine = registry.get(atoms.machineAtom)
    expect(machine).toEqual({ state: 'idle', format: 'csv' })
    expect(selectExportFormat(machine)).toBe('csv')
    expect(selectExporting(machine)).toBe(false)
    expect(selectExportMessage(machine)).toBeNull()
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
  })

  it('clears a result when the selected format changes and ignores changes during export', () => {
    const failed: ExportMachine = { state: 'failed', format: 'csv', message: 'Disk full.' }
    expect(transitionExport(failed, { type: 'format-selected', format: 'json' })).toEqual({
      state: 'idle',
      format: 'json',
    })
    const exporting: ExportMachine = { state: 'exporting', format: 'csv', requestId: 4 }
    expect(transitionExport(exporting, { type: 'format-selected', format: 'json' })).toBe(exporting)
  })

  it('returns to idle silently when the user cancels the save dialog', () => {
    const cancelled = transitionExport(
      { state: 'exporting', format: 'csv', requestId: 5 },
      { type: 'completed', requestId: 5, outcome: { ok: true, data: { ok: false, cancelled: true } } },
    )
    expect(cancelled).toEqual({ state: 'idle', format: 'csv' })
    expect(selectExportMessage(cancelled)).toBeNull()
  })

  it('surfaces returned export errors and safe typed transport failures', () => {
    const exporting: ExportMachine = { state: 'exporting', format: 'csv', requestId: 7 }
    expect(
      transitionExport(exporting, {
        type: 'completed',
        requestId: 7,
        outcome: { ok: true, data: { ok: false, error: 'Permission denied' } },
      }),
    ).toEqual({ state: 'failed', format: 'csv', message: 'Permission denied' })
    expect(
      transitionExport(exporting, {
        type: 'completed',
        requestId: 7,
        outcome: { ok: false, message: 'Unable to reach the application.' },
      }),
    ).toEqual({ state: 'failed', format: 'csv', message: 'Unable to reach the application.' })
  })

  it('ignores completions from stale request IDs', () => {
    const current: ExportMachine = { state: 'exporting', format: 'json', requestId: 10 }
    expect(
      transitionExport(current, {
        type: 'completed',
        requestId: 9,
        outcome: { ok: true, data: { ok: true, path: 'old.json' } },
      }),
    ).toBe(current)
  })

  it('does not admit a second export while the first Effect is pending', async () => {
    const request = deferred<ExportResult>()
    const exportData = vi.fn(() => Effect.promise(() => request.promise))
    const { atoms, registry } = makeHarness(exportData)

    const first = dispatch(registry, atoms.exportNowAtom, undefined)
    await vi.waitFor(() => expect(exportData).toHaveBeenCalledTimes(1))
    registry.set(atoms.exportNowAtom, undefined)
    await Promise.resolve()
    expect(registry.get(atoms.machineAtom)).toMatchObject({ state: 'exporting', format: 'csv' })

    request.resolve({ ok: false, cancelled: true })
    await first
    expect(registry.get(atoms.machineAtom)).toEqual({ state: 'idle', format: 'csv' })
    expect(exportData).toHaveBeenCalledTimes(1)
  })

  it('captures the selected format and maps a typed failure to a safe message', async () => {
    const exportData = vi.fn(() => Effect.fail(new Error('unavailable')))
    const { atoms, registry } = makeHarness(exportData)
    registry.set(atoms.selectFormatAtom, 'json')

    await dispatch(registry, atoms.exportNowAtom, undefined)

    expect(exportData).toHaveBeenCalledWith({ format: 'json' })
    expect(exportData).toHaveBeenCalledTimes(1)
    expect(registry.get(atoms.machineAtom)).toEqual({
      state: 'failed',
      format: 'json',
      message: 'Unable to reach the application.',
    })
  })
})
