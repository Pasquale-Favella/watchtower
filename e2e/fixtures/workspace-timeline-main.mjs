import { error as logError } from 'node:console'
import process from 'node:process'

import { app, BrowserWindow } from 'electron'

app
  .whenReady()
  .then(async () => {
    const htmlPath = process.argv.find(argument => argument.endsWith('workspace-timeline.html'))
    if (!htmlPath) throw new Error('Timeline fixture HTML argument missing')
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadFile(htmlPath)
  })
  .catch(error => {
    logError(error)
    app.exit(1)
  })
app.on('window-all-closed', () => app.quit())
