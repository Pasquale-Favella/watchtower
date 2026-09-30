# Sandboxed renderer, a typed IPC surface, a frozen wire contract, and a renderer-side tripwire

Status: accepted

The renderer is fully sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`), and its only door is a single typed `api` object exposed via `contextBridge.exposeInMainWorld('api', api)` in the preload (`src/preload/index.ts`). Every renderer capability is an explicit, typed `api.*` method — there is no raw `ipcRenderer` access and no other bridge surface. The renderer never touches the filesystem, the pipeline, or the network; it receives only serializable, already-shaped, schema-validated payloads over IPC.

**The wire contract is frozen.** Channel names, request shapes, and payload bytes are the shared schemas (ADR 0003), compiled into both processes. The preload is the single adapter; the renderer fetch library (`src/renderer/src/shared/lib/api.ts`) binds one `window.api` channel to one shared schema per fetcher.

**The renderer tripwire.** Every payload-bearing channel is decoded again in the renderer against its authoritative shared schema: a malformed invoke result becomes a typed `{ ok: false }` error the views render as an error state (never garbage), and a malformed broadcast is dropped and logged so it can never paint garbage. Main validates renderer-supplied arguments (e.g. https-only `open-external`, ISO-4217 currency codes) rather than trusting them.

**Why:** the renderer is hostile-territory paranoia done cheaply. Because the schemas are shared (ADR 0003), re-validation costs almost nothing, and it converts "a bug in main or a drifting provider" from a crash or silent garbage into a visible error state — or a dropped event with a log line.

Under ADR 0034, migrated contracts use synchronous Effect Schema decoding through a Result-based renderer adapter. Unmigrated contracts retain their current Zod adapter until schema and consumers convert together. Preserve visible result errors and the event-dropping tripwire, including its bounded operational notice. Distinguish a codec's encoded input from its decoded value, preserve channel representations, and contain unexpected decoder defects at the Promise/event boundary. The renderer keeps its React/Promise runtime; Schema validation introduces no layers, fibers or backend IO.
