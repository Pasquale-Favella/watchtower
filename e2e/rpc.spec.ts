import { expect, test } from '@playwright/test'

import type { Api } from '../src/preload/index.js'
import { dismissOnboarding, withApp } from './app'

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

test('Overview native RPC refreshes pricing after reconnect without reload', async () => {
  await withApp(async ({ app, window }) => {
    await dismissOnboarding(window)
    await expect(window.getByText('Total spend', { exact: true })).toBeVisible()

    // The application now owns this view through AtomRpc. Removing only the
    // old invoke handler ensures a successful update must use that RPC path.
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler('overview:query'))

    const totalSpend = window
      .getByText('Total spend', { exact: true })
      .locator('xpath=following-sibling::div//span')
      .first()
    const setPrice = (input: number, output: number) =>
      window.evaluate(
        async ({ input, output }) => {
          const api = (globalThis as typeof globalThis & { window: { api: Api } }).window.api
          await api.setModelPrice('gpt-5.2-codex', input, output)
        },
        { input, output },
      )

    await setPrice(1_000_000, 2_000_000)
    await expect(totalSpend).toHaveText('$64.00')

    const pausedListenerCount = await app.evaluate(({ ipcMain }) => {
      const channel = 'rpc:v1:connect'
      const listeners = ipcMain.rawListeners(channel) as Array<Parameters<typeof ipcMain.on>[1]>
      const testGlobal = globalThis as typeof globalThis & {
        __watchtowerE2eRpcConnectListeners?: typeof listeners
      }
      testGlobal.__watchtowerE2eRpcConnectListeners = listeners
      for (const listener of listeners) ipcMain.removeListener(channel, listener)
      return listeners.length
    })
    expect(pausedListenerCount).toBeGreaterThan(0)

    try {
      await window.evaluate(async () => {
        const bridge = (globalThis as typeof globalThis & { window: { api: Api } }).window.api.rpcV1
        const connection = await bridge.connect()
        if (connection._tag !== 'Connected') throw new Error(`RPC connection failed: ${connection.code}`)
        bridge.disconnect(connection.generation)
      })
      await setPrice(2_000_000, 2_000_000)
    } finally {
      await app.evaluate(({ ipcMain }) => {
        const channel = 'rpc:v1:connect'
        const testGlobal = globalThis as typeof globalThis & {
          __watchtowerE2eRpcConnectListeners?: Array<Parameters<typeof ipcMain.on>[1]>
        }
        const listeners = testGlobal.__watchtowerE2eRpcConnectListeners ?? []
        for (const listener of listeners) ipcMain.on(channel, listener)
        delete testGlobal.__watchtowerE2eRpcConnectListeners
      })
    }

    await expect(totalSpend).toHaveText('$96.00')
  })
})
