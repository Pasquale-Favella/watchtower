import { error as logError } from 'node:console'
import process from 'node:process'

import { app, BrowserWindow } from 'electron'

app
  .whenReady()
  .then(async () => {
    const html = process.argv.find(argument => argument.endsWith('question-widgets.html'))
    if (!html) throw new Error('Question fixture HTML argument missing')
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadFile(html)
  })
  .catch(error => {
    logError(error)
    app.exit(1)
  })
app.on('window-all-closed', () => app.quit())
