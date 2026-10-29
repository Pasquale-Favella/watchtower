import { contextBridge, ipcRenderer } from 'electron'

import { createRpcBridge } from '@/platform/electron/preload/rpc.js'

const rpcOwner = createRpcBridge(ipcRenderer)
const preloadWindow = globalThis as typeof globalThis & {
  addEventListener(type: 'unload', listener: () => void, options: { once: boolean }): void
}
preloadWindow.addEventListener('unload', rpcOwner.dispose, { once: true })

/** Only the RPC transport and immutable runtime metadata cross the isolated world. */
const api = {
  rpcV1: rpcOwner.bridge,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  platform: process.platform,
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
