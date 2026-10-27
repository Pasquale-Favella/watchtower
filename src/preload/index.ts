import type { IpcRendererEvent } from 'electron'
import { contextBridge, ipcRenderer } from 'electron'

import type { Section } from '../shared/schemas/navigation.js'
import type { OrbPanelRequest, OrbPlacement } from '../shared/schemas/orb.js'
import { createRpcBridge } from './rpc.js'

const rpcOwner = createRpcBridge(ipcRenderer)
const preloadWindow = globalThis as typeof globalThis & {
  addEventListener(type: 'unload', listener: () => void, options: { once: boolean }): void
}
preloadWindow.addEventListener('unload', rpcOwner.dispose, { once: true })

/** Application operations use rpcV1; these capabilities belong to the native shell. */
const api = {
  rpcV1: rpcOwner.bridge,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  platform: process.platform,
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  openSystemSettings: (): Promise<boolean> => ipcRenderer.invoke('open-fda-settings'),
  notifyNotice: (label: string, location: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('log:notice', { label, location }),
  onNavigate: (callback: (section: Section) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, section: Section): void => callback(section)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  orb: {
    getPlacement: (): Promise<OrbPlacement | null> => ipcRenderer.invoke('orb:placement:get'),
    /** Asks the main process to open (`open`: focused, `peek`: not) or fold the panel. */
    requestPanel: (request: OrbPanelRequest): Promise<OrbPlacement | null> =>
      ipcRenderer.invoke('orb:panel:request', request),
    dragStart: (): void => ipcRenderer.send('orb:drag-start'),
    dragMove: (dx: number, dy: number): void => ipcRenderer.send('orb:drag-move', dx, dy),
    dragEnd: (): void => ipcRenderer.send('orb:drag-end'),
    openApp: (section?: Section): void => ipcRenderer.send('orb:open-app', section),
    hide: (): void => ipcRenderer.send('orb:hide'),
    quit: (): void => ipcRenderer.send('orb:quit'),
    /** The panel painted its first frame after opening (flicker-free reveal). */
    panelPainted: (): void => ipcRenderer.send('orb:panel-painted'),
    /** The panel's data is loaded: the first-close peek may open (main decides). */
    panelDataReady: (): void => ipcRenderer.send('orb:panel-data-ready'),
    onPlacement: (callback: (placement: OrbPlacement) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, placement: OrbPlacement): void => callback(placement)
      ipcRenderer.on('orb:placement', listener)
      return () => ipcRenderer.removeListener('orb:placement', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
