import { error as logError } from 'node:console'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, ipcMain } from 'electron'

app
  .whenReady()
  .then(async () => {
    const htmlPath = process.argv.find(argument => argument.endsWith('rpc-transport.html'))
    const serverModulePath = process.argv.find(argument => argument.endsWith('rpc-server.mjs'))
    if (!htmlPath || !serverModulePath) {
      throw new Error(`RPC transport fixture arguments missing: ${process.argv.join(' ')}`)
    }
    const windows = new Map()
    const roles = new Map()
    const expectedUrls = new Map()
    const delayedReadyByContents = new Map()
    const lateReady = { dispatched: 0, delivered: 0, afterDestroy: 0 }
    const { installProbeRpc } = await import(pathToFileURL(serverModulePath).href)

    const createWindow = async (name, role = name) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${process.cwd()}/out/preload/index.js`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const webContents = window.webContents
      const nativePostMessage = webContents.postMessage.bind(webContents)
      webContents.postMessage = (channel, message, transfer) => {
        const delayMs = delayedReadyByContents.get(webContents.id)
        if (channel !== 'rpc:v1:port' || delayMs === undefined) return nativePostMessage(channel, message, transfer)
        delayedReadyByContents.delete(webContents.id)
        const [latePort] = transfer ?? []
        setTimeout(() => {
          lateReady.dispatched += 1
          if (webContents.isDestroyed()) {
            lateReady.afterDestroy += 1
            latePort?.close()
            return
          }
          try {
            nativePostMessage(channel, message, transfer)
            lateReady.delivered += 1
          } catch {
            latePort?.close()
          }
        }, delayMs)
      }
      windows.set(name, window)
      roles.set(webContents.id, role)
      await window.loadFile(htmlPath)
      expectedUrls.set(webContents.id, webContents.getURL())
      await webContents.executeJavaScript(
        `document.documentElement.dataset.role = ${JSON.stringify(role)}; document.documentElement.dataset.window = ${JSON.stringify(name)}`,
      )
      return window
    }

    const rpc = installProbeRpc(ipcMain, roles, expectedUrls)
    globalThis.rpcTransportFixture = {
      delayNextReady(role, delayMs) {
        const window = windows.get(role)
        if (!window) throw new Error(`Unknown fixture role: ${role}`)
        delayedReadyByContents.set(window.webContents.id, delayMs)
      },
      closeWindow(role) {
        const window = windows.get(role)
        if (!window) throw new Error(`Unknown fixture role: ${role}`)
        window.close()
      },
      navigateWindow(name, url) {
        const window = windows.get(name)
        if (!window) throw new Error(`Unknown fixture window: ${name}`)
        return window.loadURL(url)
      },
      diagnostics() {
        return { ...rpc.diagnostics(), lateReady: { ...lateReady } }
      },
    }
    await Promise.all([
      createWindow('app'),
      createWindow('panel'),
      createWindow('beacon'),
      createWindow('foreign-document', 'app'),
    ])
  })
  .catch(error => {
    logError('[rpc-transport fixture] Electron startup failed', error)
    app.exit(1)
  })

app.on('window-all-closed', () => app.quit())
