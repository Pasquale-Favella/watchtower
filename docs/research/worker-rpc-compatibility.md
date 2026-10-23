# Effect worker RPC compatibility probe

Status: disposable compatibility evidence, not production approval. Verified on 2026-10-23 with system Node v24.13.0, Electron 43.2.0 (embedded Node v24.18.0), `effect` 4.0.5 and `@effect/platform-node` 4.0.5 on Windows.

## Result

The official `RpcClient.layerProtocolWorker({ size: 1 })` and `RpcServer.layerProtocolWorkerRunner` interoperate over `NodeWorker`/`NodeWorkerRunner` in both current Node and the installed Electron main process. The same probe passed when the worker entry and its relative RPC group module were loaded from a small fixture `.asar` archive.

The probe round-trips a structured-clone-safe object and a `Schema.TaggedError`, sends the initial worker message, interrupts a pending RPC and observes the server-side finalizer, and closes exactly one worker through scope disposal. Node tests passed 3/3. The Electron `.asar` fixture run returned one spawn and one exit with `cancelled: 1` in 1,600 ms. The launcher waits for the exact process and enforces a 30 second deadline. The main entry starts its asynchronous probe after module evaluation; the earlier top-level startup sequence hung and did not establish compatibility.

This establishes compatibility for the installed runtime and fixture layout only. It does not prove a packaged Watchtower application, production startup ordering, sandboxed preload, `file://` windows, code signing, macOS/Linux behavior, or release packaging. The archive contained only the worker runner and probe group; Effect dependencies resolved from the checkout's `node_modules`.

## Readiness and recovery behavior

`NodeWorkerRunner` reports platform readiness as it attaches its message listener. The RPC initial message is a later protocol message. In the probe, the worker decodes this value with `RpcWorker.initialMessage(Schema.String)` and the application handler layer is not started until it equals `ledger-ready`. A worker that exits before platform readiness or exits after receiving an invalid startup value causes the waiting RPC to fail with `RpcClientError` containing `WorkerReceiveError`.

Building the worker protocol layer did not itself reject on worker startup failure. The first pending call received the transport error, and the failed worker was not transparently replaced (`spawnCount` remained one). Therefore the platform's ready signal is not an application-ready acknowledgement, and this layer did not take over Watchtower's supervisor role. The probe intentionally observes the failed call rather than retrying it; admitted writes must not be replayed after a disconnect.

For integration, keep the existing supervisor as the only owner of worker replacement. Build one scoped `size: 1` client protocol per worker generation, require an explicit application-level readiness handshake before exposing the worker client, and close/join that generation before acquiring its replacement. Treat `WorkerReceiveError` as a failed generation, retain no automatic command replay, and keep stable reads/coalescing and mutation revision fencing above the transport. A failed startup acknowledgement must abort that generation before it can accept application work.

## Reproduction

Run the focused Node test:

```powershell
npm test -- --run tests/worker-rpc-compatibility.test.ts
```

Run the Electron main-process test, which packages only the two fixture files into a temporary `.asar`, launches the installed Electron executable, verifies the result, then removes the temporary archive and JSON output:

```powershell
./scripts/probes/run-worker-rpc-electron.ps1
```

The Effect adapter behavior comes from the installed [`NodeWorker`](../../node_modules/@effect/platform-node/src/NodeWorker.ts), [`NodeWorkerRunner`](../../node_modules/@effect/platform-node/src/NodeWorkerRunner.ts), and `RpcClient`/`RpcServer` worker protocol sources. Electron's [Multithreading guide](https://www.electronjs.org/docs/latest/tutorial/multithreading) says Node APIs can read ASAR archives in its Web Worker context, while also warning against loading native Node modules in worker threads. The isolated probe uses the main process's `node:worker_threads` and loads no native module from the worker. That guidance and fixture run do not substitute for testing the actual packaged app archive.
