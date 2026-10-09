import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerAgentsIpc } from '../src/main/agents/ipc.js'
import { makeMainRuntime } from '../src/main/main-runtime.js'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
    on: () => {},
  },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
  },
}))

afterEach(() => handlers.clear())

describe('Coach renderer protocol boundary', () => {
  it('bounds unexpected main-controller rejections in the real registered handlers', async () => {
    const privateError = new Error('private native details C:\\Users\\person\\config token=secret')
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} },
      {
        detect: async () => {
          throw privateError
        },
      },
    )
    const ipc = registerAgentsIpc({
      runtime,
      dismissals: { dismiss: () => {} },
      ledgerMcpServer: async () => null,
    })
    try {
      expect(await handlers.get('coach:inspect')!(undefined, 'claude')).toEqual({
        ok: false,
        error: 'An unexpected Coach failure occurred. Please retry.',
      })
      expect(await handlers.get('coach:run')!({ sender: {} }, { harnessKind: 'claude', prompt: 'hello' })).toEqual({
        ok: false,
        error: 'An unexpected Coach failure occurred. Please retry.',
      })
      expect(await handlers.get('coach:open-login-terminal')!(undefined, 'claude')).toEqual({
        ok: false,
        error: 'An unexpected Coach failure occurred. Please retry.',
      })
      for (const channel of ['coach:harnesses', 'coach:harnesses-refresh']) {
        const error = await handlers.get(channel)!().catch(error => error)
        expect(error).toBeInstanceOf(Error)
        if (!(error instanceof Error)) throw new Error('expected the IPC handler to reject with an Error')
        expect(error.message).toBe('An unexpected Coach failure occurred. Please retry.')
        expect(error.cause).toBe(privateError)
      }
    } finally {
      await ipc.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })
})
