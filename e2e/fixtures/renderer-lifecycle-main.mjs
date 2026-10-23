import process from 'node:process'

import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  void window.loadFile(process.argv[2])
})
app.on('window-all-closed', () => app.quit())
