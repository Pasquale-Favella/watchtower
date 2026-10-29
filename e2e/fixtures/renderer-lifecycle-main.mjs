import { error as logError } from 'node:console'
import process from 'node:process'

import { app, BrowserWindow } from 'electron'

app
  .whenReady()
  .then(() => {
    const htmlPath = process.argv.find(argument => argument.endsWith('renderer-lifecycle.html'))
    if (!htmlPath) throw new Error(`Renderer lifecycle fixture HTML argument missing: ${process.argv.join(' ')}`)
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    return window.loadFile(htmlPath)
  })
  .catch(error => {
    logError('[renderer-lifecycle fixture] Electron startup failed', error)
    app.exit(1)
  })
app.on('window-all-closed', () => app.quit())
