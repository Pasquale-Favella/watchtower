# Effect worker RPC compatibility probe

Status: initial disposable compatibility evidence, followed by production integration below. The probe was verified on 2026-10-23 with system Node v24.13.0, Electron 43.2.0 (embedded Node v24.18.0), `effect` 4.0.5 and `@effect/platform-node` 4.0.5 on Windows. Current acceptance belongs to issue #174.

## Result

The official `RpcClient.layerProtocolWorker({ size: 1 })` and `RpcServer.layerProtocolWorkerRunner` interoperate over `NodeWorker`/`NodeWorkerRunner` in both current Node and the installed Electron main process. The same probe passed when the worker entry and its relative RPC group module were loaded from a small fixture `.asar` archive.

The probe round-trips a structured-clone-safe object and a `Schema.TaggedError`, sends the initial worker message, interrupts a pending RPC and observes the server-side finalizer, and closes exactly one worker through scope disposal. Node tests passed 3/3. The Electron `.asar` fixture run returned one spawn and one exit with `cancelled: 1` in 1,600 ms. The launcher waits for the exact process and enforces a 30 second deadline. The main entry starts its asynchronous probe after module evaluation; the earlier top-level startup sequence hung and did not establish compatibility.

This establishes compatibility for the installed runtime and fixture layout only. It does not prove a packaged Watchtower application, production startup ordering, sandboxed preload, `file://` windows, code signing, macOS/Linux behavior, or release packaging. The archive contained only the worker runner and probe group; Effect dependencies resolved from the checkout's `node_modules`.

## Readiness and recovery behavior

`NodeWorkerRunner` reports platform readiness as it attaches its message listener. The RPC initial message is a later protocol message. In the probe, the worker decodes this value with `RpcWorker.initialMessage(Schema.String)` and the application handler layer is not started until it equals `ledger-ready`. A worker that exits before platform readiness or exits after receiving an invalid startup value causes the waiting RPC to fail with `RpcClientError` containing `WorkerReceiveError`.

Building the worker protocol layer did not itself reject on worker startup failure. The first pending call received the transport error, and the initial fixture observed one spawn. The platform's ready signal is therefore not an application-ready acknowledgement. This short observation did not prove that the official protocol has no internal recovery policy. Its installed implementation retries the worker backing loop at one-second intervals, and the Node adapter's finalizer permits five seconds for graceful exit before termination.

For integration, keep the existing supervisor as the only owner of worker replacement. Build one scoped `size: 1` client protocol per worker generation, require an explicit application-level readiness handshake before exposing the worker client, and close/join that generation before acquiring its replacement. Treat `WorkerReceiveError` as a failed generation, retain no automatic command replay, and keep stable reads/coalescing and mutation revision fencing above the transport. A failed startup acknowledgement must abort that generation before it can accept application work.

## Per-generation supervisor proof

`tests/worker-rpc-supervision.test.ts` exercises that narrower composition with
real Node workers. The supervisor creates the native worker; a one-shot Spawner
returns that exact worker to the official protocol. The native exit callback
closes the protocol scope immediately, before its internal retry interval.

The three cases pass. Fatal initialization produces one exit and no replacement
after waiting beyond the retry interval. A write increments a shared counter,
then loses its response when the worker is terminated. The client fails once,
the counter stays at one, scope cleanup finishes within one second, and there
is one termination call. A manually created replacement starts after the old
worker exits and its scope closes; at most one native worker is alive. Normal
shutdown sends the application shutdown RPC before the official close handshake
and needs no forced termination.

This supports the per-generation composition without replacing Watchtower's
supervisor policy. It does not yet exercise `DbWorkerContext`, synchronous SQL,
stable-read coalescing, real abort drainage, or the packaged Watchtower worker.
Those remain S12 integration requirements. The fixture's startup acknowledgement
also does not substitute for the production ledger-ready handshake.

## Production integration, 2026-10-27

The application now uses `WorkerRpcGroup` and the official Node worker adapters.
`DbWorkerClient` remains the sole supervisor. Each generation supplies its one
native Worker to a one-shot Spawner and joins that protocol scope before
replacement. Ordinary requests retain the existing 128-operation admission
limit. The single-worker protocol pool reserves three additional leases for the
event stream, abort and shutdown. Its default concurrency of one would otherwise
let the lifetime event stream prevent readiness and application calls.

The client subscribes to the bounded, sequenced event stream before requesting
ledger readiness. Unary success and operation-error watermarks delay settlement
until the main consumer has applied preceding events. Native worker handlers
compose the existing context's Effects and service graph. They do not acquire a
second SQL runtime. Safe error codes preserve intentional failure categories;
scan and pricing failures use fixed messages. Application shutdown precedes the
official close handshake under the supervisor's existing deadline. Pure
interruption during normal worker close is a successful process exit.

The production-entry Node tests cover a 128-session fixture scan, config-event
ordering, clear/reset, graceful exit with no forced termination, fatal
initialization without respawn, and real corrupted-row/missing-table failures
with safe prior Operational log records. Separate actual-worker tests retain
stable-read/coalescing evidence and prove that forced abort recovery prevents a
late callback from writing. Protocol tests cover lost committed replies without
replay and control calls at ordinary-request saturation. Existing context tests
still verify parser drainage before SQL disposal.

These results supplement the initial probe. They do not replace the final
packaged Electron and supported-target acceptance recorded in #174.

Full CI at `d390d0b` passed the actual Windows/Linux Electron steps and all
three installer acceptance targets. The preceding Linux core failure exposed
the event queue's 256-item bound during a synchronous scan burst. The server
now permits 4096 queued events while retaining its 2 MiB JSON byte bound and
1 MiB per-frame bound. A regression test verifies ordered delivery of 1024
synchronously produced events. Overflow has an explicit safe error code.
The later strengthened three-window verifier at `2ad1262` passes Windows and
macOS but fails Linux while opening the panel after a beacon click; its
preceding packaged worker, SQL and MCP flows pass. That lifecycle gate remains
open and is tracked separately from the worker protocol evidence.

## Probe reproduction

Run the focused Node test:

```powershell
npm test -- --run tests/worker-rpc-compatibility.test.ts tests/worker-rpc-supervision.test.ts
```

Run the Electron main-process test, which packages only the two fixture files into a temporary `.asar`, launches the installed Electron executable, verifies the result, then removes the temporary archive and JSON output:

```powershell
./scripts/probes/run-worker-rpc-electron.ps1
```

The Effect adapter behavior comes from the installed [`NodeWorker`](../../node_modules/@effect/platform-node/src/NodeWorker.ts), [`NodeWorkerRunner`](../../node_modules/@effect/platform-node/src/NodeWorkerRunner.ts), and `RpcClient`/`RpcServer` worker protocol sources. Electron's [Multithreading guide](https://www.electronjs.org/docs/latest/tutorial/multithreading) says Node APIs can read ASAR archives in its Web Worker context, while also warning against loading native Node modules in worker threads. The isolated probe uses the main process's `node:worker_threads` and loads no native module from the worker. That guidance and fixture run do not substitute for testing the actual packaged app archive.
