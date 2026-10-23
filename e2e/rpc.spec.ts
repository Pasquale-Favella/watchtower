import { expect, test } from '@playwright/test'

import type { Api } from '../src/preload/index.js'

import { withApp } from './app'

test('sandboxed preload carries RPC frames and replaces the connection after reload', async () => {
  await withApp(async ({ app, window }) => {
    await window.waitForFunction(() =>
      Boolean((globalThis as typeof globalThis & { window: { api: Api } }).window.api?.rpcV1),
    )
    const security = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))
      // Electron exposes this runtime introspection method without a public declaration.
      const contents = main?.webContents as
        (Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences }) | undefined
      const preferences = contents?.getLastWebPreferences()
      return {
        sandbox: preferences?.sandbox,
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
      }
    })
    expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })

    const query = () =>
      window.evaluate(async () => {
        const bridge = (globalThis as typeof globalThis & { window: { api: Api } }).window.api.rpcV1
        const connection = await bridge.connect()
        if (connection._tag !== 'Connected') throw new Error(`RPC connection failed: ${connection.code}`)
        const response = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe()
            reject(new Error('RPC query timed out'))
          }, 30_000)
          const unsubscribe = bridge.onMessage(raw => {
            if (typeof raw !== 'string') return
            const frame = JSON.parse(raw)
            if (frame._tag !== 'Exit' || frame.requestId !== 'sandbox-probe') return
            clearTimeout(timer)
            unsubscribe()
            resolve(frame.exit)
          }, connection.generation)
          bridge
            .send(
              JSON.stringify({ _tag: 'Request', id: 'sandbox-probe', tag: 'store:status', payload: null, headers: [] }),
              connection.generation,
            )
            .catch(error => {
              clearTimeout(timer)
              unsubscribe()
              reject(error)
            })
        })
        const browser = (globalThis as typeof globalThis & { window: object }).window
        return { connection, response, rawIpc: 'ipcRenderer' in browser, nodeRequire: 'require' in browser }
      })
    const first = await query()
    expect(first).toMatchObject({
      connection: { _tag: 'Connected' },
      response: { _tag: 'Success', value: { scanned: expect.any(Boolean) } },
      rawIpc: false,
      nodeRequire: false,
    })
    await window.reload()
    await window.waitForFunction(() =>
      Boolean((globalThis as typeof globalThis & { window: { api: Api } }).window.api?.rpcV1),
    )
    const second = await query()
    expect(second.response).toMatchObject({ _tag: 'Success' })
    expect(second.connection.generation).toBeGreaterThan(first.connection.generation)
  })
})
