import { BrowserWindow, session, shell, type WebContents, WebContentsView } from 'electron'

import { workspacePreviewMessages, WorkspacePreviewRpcError } from '@/shared/rpc/workspace-preview.js'
import { normalizeWorkspacePreviewUrl } from '@/shared/schemas/workspace-preview.js'

import { createPreviewAutomation } from './preview-automation.js'
import { WorkspacePreviewManager, type WorkspacePreviewView, type WorkspacePreviewWindow } from './preview-manager.js'

function createView(): WorkspacePreviewView {
  const browserSession = session.fromPartition('persist:workspace-browser')
  browserSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  browserSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write'),
  )
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  })
  const contents = view.webContents
  let automation: ReturnType<typeof createPreviewAutomation> | undefined
  contents.on('will-frame-navigate', event => {
    if (!normalizeWorkspacePreviewUrl(event.url)) event.preventDefault()
  })
  contents.on('will-redirect', event => {
    if (!normalizeWorkspacePreviewUrl(event.url)) event.preventDefault()
  })
  contents.on('will-attach-webview', event => event.preventDefault())
  view.setVisible(false)
  return {
    nativeView: view,
    automate: (operation, input, signal) => {
      automation ??= createPreviewAutomation(contents)
      return automation.execute(operation, input, signal)
    },
    resetAutomation: async () => {
      await automation?.reset()
    },
    capture: async bounds => {
      const image = await contents.capturePage(bounds)
      const size = image.getSize()
      const scale = Math.min(1, 2048 / Math.max(size.width, size.height))
      const scaled =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'better',
            })
          : image
      const data = scaled.toPNG()
      if (data.byteLength > 4 * 1024 * 1024)
        throw new WorkspacePreviewRpcError({
          code: 'limit-reached',
          message: workspacePreviewMessages['limit-reached'],
        })
      return {
        dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        ...scaled.getSize(),
        url: contents.getURL().slice(0, 8192),
      }
    },
    loadURL: url => contents.loadURL(url),
    setBounds: bounds => view.setBounds(bounds),
    setVisible: visible => view.setVisible(visible),
    snapshot: () => ({
      url: contents.isDestroyed() ? '' : contents.getURL().slice(0, 8192),
      title: contents.isDestroyed() ? '' : contents.getTitle().slice(0, 512),
      loading: !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      muted: !contents.isDestroyed() && contents.isAudioMuted(),
      zoomFactor: contents.isDestroyed() ? 1 : contents.getZoomFactor(),
    }),
    async command(action) {
      if (contents.isDestroyed())
        throw new WorkspacePreviewRpcError({ code: 'not-found', message: workspacePreviewMessages['not-found'] })
      switch (action) {
        case 'back':
          if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
          break
        case 'forward':
          if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
          break
        case 'reload':
          contents.reload()
          break
        case 'stop':
          contents.stop()
          break
        case 'external': {
          const url = normalizeWorkspacePreviewUrl(contents.getURL())
          if (url) await shell.openExternal(url)
          break
        }
        case 'devtools':
          contents.openDevTools({ mode: 'detach' })
          break
        case 'toggle-mute':
          contents.setAudioMuted(!contents.isAudioMuted())
          break
        case 'zoom-in':
          contents.setZoomFactor(Math.min(3, Math.round((contents.getZoomFactor() + 0.1) * 10) / 10))
          break
        case 'zoom-out':
          contents.setZoomFactor(Math.max(0.25, Math.round((contents.getZoomFactor() - 0.1) * 10) / 10))
          break
        case 'zoom-reset':
          contents.setZoomFactor(1)
          break
      }
    },
    subscribe(changed, failed, popup, shortcut) {
      const onInput = (event: Electron.Event, input: Electron.Input) => {
        if (input.type !== 'keyDown' || !(process.platform === 'darwin' ? input.meta : input.control)) return
        const key = input.key.toLowerCase()
        if (key === 'b' && input.alt && !input.shift) {
          event.preventDefault()
          shortcut('toggle-panel')
          return
        }
        if (input.alt) return
        if (key === 'tab') {
          event.preventDefault()
          shortcut(input.shift ? 'previous-tab' : 'next-tab')
          return
        }
        if (input.shift) return
        switch (key) {
          case 'l':
            event.preventDefault()
            shortcut('address')
            break
          case 't':
            event.preventDefault()
            shortcut('new-tab')
            break
          case 'w':
            event.preventDefault()
            shortcut('close-tab')
            break
          case 'j':
            event.preventDefault()
            shortcut('toggle-terminal')
            break
          case 'r':
            event.preventDefault()
            contents.reload()
            break
        }
      }
      const onFail = (_event: unknown, code: number, _description: string, _url: string, mainFrame: boolean) => {
        if (mainFrame && code !== -3) failed()
      }
      contents.on('did-start-loading', changed)
      contents.on('did-stop-loading', changed)
      contents.on('did-navigate', changed)
      contents.on('did-navigate-in-page', changed)
      contents.on('page-title-updated', changed)
      contents.on('did-fail-load', onFail)
      contents.on('render-process-gone', failed)
      contents.on('before-input-event', onInput)
      contents.setWindowOpenHandler(details => {
        if (normalizeWorkspacePreviewUrl(details.url)) popup(details.url)
        return { action: 'deny' }
      })
      return () => {
        contents.off('did-start-loading', changed)
        contents.off('did-stop-loading', changed)
        contents.off('did-navigate', changed)
        contents.off('did-navigate-in-page', changed)
        contents.off('page-title-updated', changed)
        contents.off('did-fail-load', onFail)
        contents.off('render-process-gone', failed)
        contents.off('before-input-event', onInput)
      }
    },
    destroy: () => {
      automation?.dispose()
      if (!contents.isDestroyed()) contents.close()
    },
  }
}

export function createElectronWorkspacePreviewManager(): WorkspacePreviewManager {
  return new WorkspacePreviewManager({ createView })
}

const watchedWindows = new WeakMap<WorkspacePreviewManager, Set<number>>()

/** Only the authenticated application's own window can attach and position a browser page. */
export function workspacePreviewWindow(manager: WorkspacePreviewManager, sender: WebContents): WorkspacePreviewWindow {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed())
    throw new WorkspacePreviewRpcError({ code: 'unavailable', message: workspacePreviewMessages.unavailable })
  let watched = watchedWindows.get(manager)
  if (!watched) {
    watched = new Set()
    watchedWindows.set(manager, watched)
  }
  if (!watched.has(window.id)) {
    watched.add(window.id)
    sender.on('did-start-loading', () => manager.hideWindow(window.id))
    window.once('closed', () => {
      manager.closeWindow(window.id)
      watched.delete(window.id)
    })
  }
  return {
    id: window.id,
    contentSize: () => {
      if (window.isDestroyed()) return { width: 0, height: 0 }
      const [width, height] = window.getContentSize()
      return { width, height }
    },
    attach: view => {
      if (!window.isDestroyed()) window.contentView.addChildView(view.nativeView as WebContentsView)
    },
    detach: view => {
      if (!window.isDestroyed()) window.contentView.removeChildView(view.nativeView as WebContentsView)
    },
  }
}
