import { runtime } from '../../app/renderer-runtime.js'
import { createApplicationAtomRpc } from './atom-rpc.js'
import { RendererProtocolLayer } from './rpc-connection.js'

/** Shared protocol layer for the application client and renderer connection-state consumer. */
export const ApplicationProtocolLayer = RendererProtocolLayer

/** Stable application client; its AtomRpc runtime is owned by the renderer root. */
export const ApplicationClient = createApplicationAtomRpc(runtime, ApplicationProtocolLayer)
