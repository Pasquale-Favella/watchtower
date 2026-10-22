import { expect, test } from '@playwright/test'

import { withApp } from './app'

test('sandboxed preload carries RPC frames and replaces the connection after reload', async () => {
  await withApp(async ({ app, window }) => {
    await window.waitForFunction(() => Boolean(window.api?.rpcV1))
    const security = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))
      const preferences = main?.webContents.getLastWebPreferences()
      return {
        sandbox: preferences?.sandbox,
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
      }
    })
    expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })

    const query = () =>
      window.evaluate(async () => {
        const bridge = window.api.rpcV1
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
          })
          bridge
            .send(
              JSON.stringify({ _tag: 'Request', id: 'sandbox-probe', tag: 'store:status', payload: null, headers: [] }),
            )
            .catch(error => {
              clearTimeout(timer)
              unsubscribe()
              reject(error)
            })
        })
        return { connection, response, rawIpc: 'ipcRenderer' in window, nodeRequire: 'require' in window }
      })
    const first = await query()
    expect(first).toMatchObject({
      connection: { _tag: 'Connected' },
      response: { _tag: 'Success', value: { scanned: expect.any(Boolean) } },
      rawIpc: false,
      nodeRequire: false,
    })
    await window.reload()
    await window.waitForFunction(() => Boolean(window.api?.rpcV1))
    const second = await query()
    expect(second.response).toMatchObject({ _tag: 'Success' })
    expect(second.connection.generation).toBeGreaterThan(first.connection.generation)
  })
})
