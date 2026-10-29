# Effect Atom and RPC adoption assessment, 2026-10-22

Assessed checkout: `5187054df75a5bbd98ccbb81e82469b762d5ad7b`. The working tree was clean before this research. This is a new assessment of renderer adoption after the completed backend and Schema migrations. The implementation sequence and completion gates are in [the adoption plan](../plans/effect-renderer-adoption.md). Neither document changes an accepted ADR or implements the migration.

## Recommendation

Adopt Effect Atom for shared renderer state and Effect services for renderer workflows. Adopt Effect RPC through a separately versioned Electron transport after an executable transport spike. Use AtomRpc for ordinary remote queries and guarded mutations. Preserve React for rendering and local interaction state, TanStack Router for navigation, and the db-worker for SQLite and scans.

Define three independently verifiable outcomes:

1. The renderer has no Zustand dependency. Its shared state, asynchronous workflows and subscriptions use Atom and scoped Effect composition over the existing bridge.
2. Renderer-to-main application requests use shared RPC contracts, with typed transport failures and explicit streaming lifetimes. The frozen legacy IPC methods are retired only after their callers migrate.
3. The main-to-db-worker request protocol also uses shared RPC contracts. Watchtower retains the worker supervisor, stable-read policy, scan ownership and shutdown guarantees around that protocol.

The first outcome does not require either RPC migration. The second does not establish typed failures across the worker boundary while that boundary still returns `unknown` and string errors. Scope the claims and release gates accordingly.

## Corrections to the initial proposal

| Initial claim or implication                                       | Finding against this checkout                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replacing Zustand enables RPC                                      | Atom and RPC solve different problems. Each can be adopted independently.                                                                                                                                                           |
| Import from `effect/unstable/reactivity` and `effect/unstable/rpc` | The installed 4.0.5 exports are `effect/reactivity` and `effect/rpc`. Production code follows the repository's subpath-import rule, such as `effect/reactivity/Atom` and `effect/rpc/Rpc`.                                          |
| Stable Effect makes the integration stable                         | Atom, AtomRpc, Reactivity, RPC and the examined worker adapters still carry `@stability unstable`. Pin matching packages and test upgrades.                                                                                         |
| An appropriate React binding exists                                | Confirmed. Published `@effect/atom-react@4.0.5` requires Effect `^4.0.5`, React `>=19.0.0 <20.0.0` and scheduler `>=0.25.0 <0.29.0`. Installed React/ReactDOM are 19.2.8 and scheduler is 0.27.0. The binding is not installed yet. |
| Data stores already cache multiple Scopes                          | They retain one current payload per slice. `dataKey` prevents an old Scope response replacing a new one. A retained family of Scopes would change memory and revisit behavior.                                                      |
| `timeToLive: '30 seconds'` controls freshness                      | AtomRpc maps finite TTL to `Atom.setIdleTTL`. It controls disposal after inactivity, not polling, a freshness deadline or a periodic refetch.                                                                                       |
| Mutation invalidation automatically updates every window           | Reactivity and registry state are local to a renderer isolate. Authoritative worker/main events must reach every eligible window and invalidate its own registry.                                                                   |
| Streaming RPC queries are ordinary async value atoms               | AtomRpc returns a pull atom for streaming successes. Consumption must advance it; accumulated results can grow. A continuous Coach run should have an explicitly owned Stream consumer.                                             |
| The previous rejection of worker RPC still applies                 | Its two availability blockers are gone: owned schemas now use Effect Schema, and installed platform-node includes Node worker adapters. Its lifecycle and coalescing concerns still apply.                                          |
| MessagePort removes all bridge design work                         | It supplies messaging. Watchtower still needs connection setup, capability restrictions, encoding, disconnect behavior and lifecycle integration.                                                                                   |

The public 4.0.5 references confirm the module paths and unstable annotations. The installed source is the version-specific implementation authority. [AtomRpc reference](https://effect.website/docs/v4/api/effect/reactivity/AtomRpc), [Atom reference](https://effect.website/docs/v4/api/effect/reactivity/Atom), [React binding package at the 4.0.5 tag](https://raw.githubusercontent.com/Effect-TS/effect/%40effect%2Fatom-react%404.0.5/packages/atom/react/package.json).

## Current renderer inventory

There are 22 renderer files importing Zustand directly, including eight views using `zustand/react/shallow`. There are 13 state-bearing store modules, the generic `data-store.ts` factory, and four feature modules using that factory. Removing only `app/stores` would leave most adoption incomplete.

| Current code                                                                                | Responsibility and behavior to carry forward                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/stores/scope-store.ts`                                                                 | Transient period/provider/custom range. Initial period comes synchronously from persisted settings. Changing period clears the custom range.                                             |
| `app/stores/palette-store.ts`                                                               | Command palette state. Navigation itself belongs to the router.                                                                                                                          |
| `app/stores/data-store.ts`                                                                  | Same-Scope stale-while-revalidate, fresh loading on Scope change, keyed response guard and refresh registration. It does not prevent two same-key requests racing.                       |
| `features/overview/store.ts`, `spend/store.ts`, `models/store.ts`, `pull-requests/store.ts` | Thin instances of the generic scoped store. Overview is the lowest-risk remote-data pilot.                                                                                               |
| `features/sessions/store.ts`                                                                | Scoped list plus detail keyed by both `sessionId` and optional `sourceId`. The refresh callback currently reloads the list, not the open detail.                                         |
| `features/compare/store.ts`                                                                 | Scope plus ordered model pair. An omitted pair adopts the pair selected in the response, which later refreshes retain.                                                                   |
| `features/optimize/store.ts`                                                                | Independent findings and delivery-evidence slices. Delivery evidence remains lazy until opened.                                                                                          |
| `features/models/pricing-store.ts`                                                          | Alias and Price override commands; lazy config/picker reads; immediate post-write list refresh plus broadcast-driven refresh. Derived priced/unpriced arrays need stable subscriptions.  |
| `features/settings/store.ts`                                                                | Mixed local persisted preferences and worker-fed cadence/currency. Six fields persist in `watchtower:settings`; server data does not.                                                    |
| `features/settings/updates-store.ts`                                                        | Explicit request state machine, revision ordering and manually invoked update operations. A late invoke response cannot overwrite a newer event revision.                                |
| `features/settings/export-store.ts`                                                         | Explicit request identity, format selection, busy admission and user cancellation outcomes.                                                                                              |
| `features/coach-skills/store.ts`                                                            | Conversation, harness selection/probing/cache, detection query, early-event buffering, run identity, cancellation and workspace reset. It also has a module-level settings subscription. |
| `orb/panel-store.ts`                                                                        | Two fixed Overview Scopes, `today` and `30days`; shared initial flight; panel-data-ready lifecycle.                                                                                      |
| `orb/placement-store.ts`                                                                    | Mirrors main-owned placement. Main owns opening/folding/peek timing and native movement.                                                                                                 |

Shared wiring is already split correctly. `app/stores/shared-wiring.ts` composes scan lifecycle, ledger/config changes, FX and storage synchronization. `subscribe.ts` adds app-only Coach, updates and navigation. `orb/beacon-wiring.ts` receives no ledger data; `orb/panel-wiring.ts` includes the data plane. Preserve those import and capability differences.

The intended window-access boundary is imperfect in current code. `scan-store.ts` reads `window.api.platform`; Coach cancellation/reset call `window.api` directly; settings persist uses `localStorage`. Renderer adoption should move these calls into injected browser/bridge adapters as each slice changes. It should not merely copy the exceptions into Atom definitions.

Store replacement also misses component-owned remote workflows. Settings' `general-pane.tsx`, `providers-pane.tsx`, `privacy-pane.tsx` and `mcp-pane.tsx` invoke fetchers directly. Privacy subscribes to the refresh tick and starts a rescan after a successful clear. MCP settings own startup-mode changes, connection-copy and token regeneration. `harness-setup.tsx` invokes login-terminal operations; several views and Markdown call `window.api.openExternal` directly. Include those callers in renderer adoption. Browser-only interaction state, such as a copied indicator, can stay local to React.

`shared/lib/currency.ts` also holds mutable module-level display currency outside Zustand. Removing Zustand alone would not make renderer state composition coherent. Migrate that formatting dependency deliberately, preserving raw USD calculations and conversion only at display/export boundaries.

## Existing refresh and worker guarantees

`scan-store.applyChange()` reads scan status, reads analytics for detected providers, then advances the refresh version and notifies listeners. A failed scan-status read exits before notifying; a failed analytics read clears detected providers. That order is current behavior, not a requirement to hide inside a new generic query layer. The plan calls for an explicit policy and regression cases before separating metadata hydration from query invalidation.

The refresh-listener set retains callbacks at module scope. Once a feature has loaded, navigating away does not necessarily stop its later reloads. Atom's observer-driven evaluation can reduce those reads, but an unopened query and a previously opened inactive query are different cases. Define both policies before replacing the tick.

The db-worker client does more than correlate request IDs:

- `DEDUPABLE_OPS` coalesces identical in-flight pure reads across renderer windows. `scan:active` is deliberately excluded because it is time-varying.
- `dataRevision` advances on `store:changed` and `config:changed`. `stableReadEffect()` re-executes a read if a change overtakes its response. A query cache is not a replacement for this consistency rule.
- A boot initialization failure is fatal without a respawn loop. A post-ready crash can create a replacement, while pending calls fail without replaying writes.
- Abort recovery waits for cooperative completion or terminates the stuck worker, waits for termination, and only then admits a replacement. It retains a failed recovery so later calls fail closed.
- SQLite work and complete synchronous transaction units stay on the one owning worker. RPC request concurrency does not authorize concurrent writers or migration of SQL onto main.

These behaviors are implemented in `src/main/db-worker/client.ts`, `context.ts`, `entry.ts` and `protocol.ts`. Keep their behavioral tests through any transport replacement.

## What changed since the previous RPC spike

[The rc.115 spike](effect-unstable-rpc-spike.md) declined worker RPC because it required a duplicate Effect schema tree beside Zod and because no compatible Node worker implementation shipped then. ADR 0034 removed the first premise. The installed `@effect/platform-node/src/NodeWorker.ts` and `NodeWorkerRunner.ts` remove the second.

`NodeWorker.layer` accepts a spawning callback for Node workers. `NodeWorkerRunner.layer` runs inside the worker. Core `RpcClient.layerProtocolWorker` and `RpcServer.layerProtocolWorkerRunner` supply the RPC integration. Reuse those before considering a custom Node worker transport. They do not by themselves prove compatibility with Watchtower's boot readiness, `workerData`, crash replacement, shutdown and Electron packaging. [Official NodeWorker implementation at 4.0.5](https://raw.githubusercontent.com/Effect-TS/effect/%40effect%2Fplatform-node%404.0.5/packages/platform/node/src/NodeWorker.ts), [NodeWorkerRunner implementation](https://raw.githubusercontent.com/Effect-TS/effect/%40effect%2Fplatform-node%404.0.5/packages/platform/node/src/NodeWorkerRunner.ts).

The old measurement and lifecycle conclusions remain useful historical evidence. Do not carry forward its old operation counts, Zod constraints or missing-transport conclusion as current findings. No speedup follows from changing the protocol; current query implementations have evolved since the earlier measurements.

## AtomRpc behavior that affects the design

`node_modules/effect/src/reactivity/AtomRpc.ts` provides a service, an Atom runtime, memoized queries and mutation functions. Query identity includes the procedure tag, payload, normalized headers, reactivity keys, TTL and serialization key. Keep request construction consistent. A hydration serialization key is unnecessary for this desktop app.

Ordinary queries expose `AsyncResult`. A failure can retain `previousSuccess`; a pending refresh can retain the prior value. UI selectors must distinguish first load, successful `null`, refresh, initial failure and refresh failure. Rendering every `Failure` as a full-screen error would regress current behavior. [AsyncResult reference](https://effect.website/docs/v4/api/effect/reactivity/AsyncResult).

Mutations invalidate supplied keys after Effect success. A successful Effect containing `{ ok: false }` remains a successful Effect. Current operations with application-result envelopes need an adapter or an explicit outcome policy before automatic invalidation is useful. Transport errors, domain refusals, user cancellation and defects should not all become one opaque string.

There is another command-specific issue. `mutation(tag)` memoizes one result function per tag; the underlying `runtime.fn` uses the default non-concurrent behavior. The source API does not expose a concurrency option on `mutation`. Do not share that result function across independent simultaneous writes without a test proving the desired behavior. Choose admission, serialization or separately keyed command execution. Reads can be superseded; commands that may have committed cannot be treated as disposable latest-value requests.

`Atom.context()` uses a registry-scoped Layer memo map. Select one renderer runtime factory per window so query atoms, event consumers and invalidation share the same Reactivity service. Building a separate ManagedRuntime with another Reactivity layer would risk invalidating a different service instance. The same atom definition in two registries still has different state.

Scope, preferences and conversation state must survive periods with no component reader. Define their lifetime explicitly. Blanket `keepAlive` on remote query families instead retains old Scopes and listeners indefinitely.

## Electron transport assessment

Three alternatives are viable, but serve different adoption stages:

| Transport                                                                         | Appropriate use                                 | Remaining work                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing explicit `window.api` methods                                            | First renderer migration and per-slice rollback | Effect adapters, typed local failures, resource ownership. No wire change and no claim of native Effect RPC.                                                                   |
| Fixed, versioned IPC channels carrying RPC envelopes                              | Simpler fallback if the port spike fails        | Client/server Protocol adapters, correlation/disconnect policy, streaming flow control. Ordinary invoke alone does not supply bidirectional cancellation and acknowledgements. |
| MessagePort between main and isolated preload, fixed bridge functions to renderer | Preferred RPC candidate                         | Port establishment, readiness, connection generation, callbacks, encode/decode, capability checks, bounds, disconnect and cleanup.                                             |

Electron can transfer ports using `postMessage`; `send` and `invoke` do not transfer them. Main uses `MessagePortMain`, which has a different event API and requires `start()` to release queued messages. Electron also supplies close events. [Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports), [MessagePortMain](https://www.electronjs.org/docs/latest/api/message-port-main).

The preferred candidate keeps the port owned by preload and exposes a small `api.rpcV1` adapter made of functions and cloneable data. The renderer never receives raw `ipcRenderer` or chooses arbitrary Electron channel names. An alternative transfer into the main world requires its own source/handshake policy and an explicit amendment of ADR 0005. It is unnecessary for the first candidate. Electron's bridge proxies functions and copies other supported data; returning an Effect runtime, class instance or native port as a normal bridge value is not the design. [contextBridge documentation](https://www.electronjs.org/docs/latest/api/context-bridge).

Implement the Effect Protocol interfaces, including their codec selection. In 4.0.5 `RpcClient.Protocol` and `RpcServer.Protocol` include `codecFor` as well as send/run and capability flags. Select one serializer/codec for the adapter; do not bypass Schema encoding by passing decoded class instances as structured-clone messages. Transport support for acknowledgements and notifications must reflect actual behavior. [RpcClient reference](https://effect.website/docs/v4/api/effect/rpc/RpcClient), [RpcServer reference](https://effect.website/docs/v4/api/effect/rpc/RpcServer).

This is a proposed design, not a completed Electron transport spike. Metadata/source inspection cannot establish behavior under the real sandbox, production `file://`, renderer reload or port failure.

## ADR conflicts and repository practice

This adoption contradicts explicit current decisions:

- ADRs 0005 and 0034 say renderer decoding introduces no runtime, layers or fibers, and preserve the Promise facade.
- ADR 0011 specifies Zustand-era slices, a shared refresh tick and the current subscription layout.
- ADR 0032 limits the default Effect runtime model to backend workflows and preserves current React data fetching.
- ADR 0023 freezes the renderer contract and documents the current worker request protocol.

The implementation needs an explicit renderer adoption decision and a versioned RPC boundary decision. Preserve schema authority, tripwire validation, process ownership and the behavioral guarantees underneath those ADRs. ADR 0014 still owns navigation; adoption should not introduce route loaders or Atom navigation state. ADRs 0009, 0012, 0013 and 0015 still govern currency, local-first operation, manual updates, exports and supported packaging targets.

Use the existing vertical-slice practice from ADR 0032. Replace a workflow's orchestration and retire its old owner in the same slice. Temporary Promise adapters belong at the foreign bridge boundary. A second permanent Zustand/Atom data copy would add a synchronization problem.

Issues and PRDs belong in GitHub. Existing adoption issues #148 and #156 are closed; this is new scope. Open issue #75 is a conditional deferred-refactor list, not approval for a registry rewrite. The plan provides ticket-sized work and dependencies for a new adoption issue. This research did not publish issues or comments, assign work, or change triage labels.

## Verification performed

Read the current package/lock metadata, relevant ADRs, renderer stores and wiring, preload, main/worker boundaries, Effect source and tagged official React/worker sources. Queried npm metadata with `npm view @effect/atom-react@4.0.5 ...`; no package was installed and no lockfile changed.

Executed small Node ESM probes against installed Effect 4.0.5:

| Probe                                                                             | Observed result                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Two AtomRpc queries with the same payload reference                               | Same atom object.                                                                  |
| Atom family with equal plain objects                                              | Same family member in this installed release.                                      |
| An effect atom read, refreshed successfully, then failed                          | Values 1 and 2; final Failure retained previous success 2.                         |
| Same query mounted in two registries, then invalidated through its runtime in one | First registry advanced from 1 to 3; second remained at 2. Invalidation was local. |

The probes use fake/in-process Effects. They do not exercise RPC serialization, an Electron bridge, React hooks, TTL expiration, command concurrency or remote cancellation.

Ran the existing behavioral baseline with Vitest 5.0.5 on this Windows checkout. All 15 files and 214 tests passed:

```text
tests/data-stores.test.ts              tests/scope-store.test.ts
tests/scan-store.test.ts               tests/settings-store.test.ts
tests/pricing-store.test.ts            tests/subscribe.test.ts
tests/orb-store.test.ts                tests/orb-subscribe.test.ts
tests/coach-store.test.ts              tests/updates-store.test.ts
tests/export-store.test.ts             tests/compare-default-pair.test.ts
tests/source-aware-session.test.ts     tests/worker-query-dispatch.test.ts
tests/worker-abort-recovery.test.ts
```

The complete suite, production build, packaged acceptance, React-binding execution and transport prototype are implementation gates, not completed evidence from this research. No performance improvement is claimed.
