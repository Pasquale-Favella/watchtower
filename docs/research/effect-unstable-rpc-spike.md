# Spike: `effect/unstable/rpc` + `effect/unstable/workers` vs our hand-rolled db-worker protocol

Answers the standing question raised at `docs/research/effect-v4-electron.md:67`
(module table) and `:260` (addendum decision 5) / `:281` (decision 8). Base commit
`e7f7efd`, branch `146-ledger-schema-migrations`, `effect@4.0.0-rc.115`
(`node_modules/effect/package.json`).

Slice 0 changed the premise: the payloads that actually cross the
`worker_threads` boundary are 1–39 KiB (`store:views` 22.4 KiB, `store:analytics`
1.5 KiB, `overview:query` 38.9 KiB), so "the volume makes a typed RPC layer
interesting" is dead. What remains is the _typing_ argument. This spike tests
whether that argument survives contact with three hard constraints: the Zod lock
(`docs/architecture.md:118-120`), the frozen renderer wire contract, and the
absence of any shipped Node worker transport.

## 1. Verdict

**Decline.** Not because the current protocol is good — it is thin but honest —
but because `Rpc` requires Effect `Schema` for every payload and success slot,
`rc.115` has **no** Standard-Schema reader, and the only mechanical bridge to our
Zod contracts (a `Schema.declareConstructor` shim) produces a schema whose `Type`,
`Encoded` and `~type.make.in` are all `undefined` — verified by running it. Adopting
`Rpc` therefore means either a second, parallel schema tree (forbidden) or an
untyped adapter that deletes the one benefit that justified the question. On top of
that, the unsolicited event channel, the boot handshake, the read dedup, and the
Node transport all fall outside `Rpc`, so most of the current code would survive
anyway.

There is a partial adoption worth naming, and it is _not_ `Rpc`: see §7.

## 2. Side-by-side: our op set against the `Rpc` equivalent

Our surface is **38 dispatch arms** (`src/main/db-worker/context.ts:486-847`, counted
by `case '` — the `44` in `effect-v4-electron.md:63` was accurate at an earlier
commit and is stale today), plus **9 event variants**
(`src/main/db-worker/protocol.ts:40-58`).

The "Expressible?" column is about `Rpc`'s _modelling_ ability. The "Zod lock?"
column is separate and is the one that decides the verdict — see §5.

| Our op (`context.ts` arm)                                                    | `Rpc` equivalent                                                                                                                                                                                                          | Expressible?                                                                                | Zod lock?                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `scan:start` (`:490`)                                                        | `Rpc.make('scan:start', { payload, success, error })`; handler is `async` → an `Effect`                                                                                                                                   | Yes, shape-wise                                                                             | Needs a payload schema (`{provider?}`) — small, bridgeable                                            |
| `scan:abort` (`:533`)                                                        | A second `Rpc` whose handler interrupts the stored fiber                                                                                                                                                                  | **Partly** — see §3.3                                                                       | No schema needed (`Schema.Void`)                                                                      |
| `shutdown` (`:545`)                                                          | `Rpc.make('shutdown')`, `Schema.Void`/`Schema.Void`                                                                                                                                                                       | Yes                                                                                         | No schema needed                                                                                      |
| `cadence:get` (`:556`) / `cadence:set` (`:560`)                              | Two `Rpc`s, payload `Schema.String`                                                                                                                                                                                       | Yes                                                                                         | `Schema.String` — no Zod contract involved                                                            |
| `store:status` (`:577`)                                                      | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | Needs a success schema (`ScanMetadata` — Zod, `src/shared/schemas/scan.ts`)                           |
| `store:views` (`:585`)                                                       | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `views.ts` payload, 143 Zod lines                                                      |
| `store:projects` (`:588`)                                                    | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `views.ts`                                                                             |
| `store:sessions` (`:591`)                                                    | One `Rpc`, payload `{project?,since?,until?}`                                                                                                                                                                             | Yes                                                                                         | **Blocking** — `views.ts` / `ledger.ts`                                                               |
| `store:session` (`:750`)                                                     | One `Rpc`, payload `Schema.String`                                                                                                                                                                                        | Yes                                                                                         | **Blocking** — `ledger.ts`, 262 Zod lines                                                             |
| `store:analytics` (`:755`)                                                   | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `ledger.ts` / `models.ts`                                                              |
| `store:search` (`:763`)                                                      | One `Rpc`, payload `Schema.String`                                                                                                                                                                                        | Yes                                                                                         | **Blocking** — `ledger.ts`                                                                            |
| `sessions:view` (`:596`)                                                     | One `Rpc`, payload `OverviewScope`                                                                                                                                                                                        | Yes                                                                                         | **Blocking** — `overview.ts`, 148 Zod lines                                                           |
| `pullRequests:view` (`:601`)                                                 | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `pull-requests.ts`                                                                     |
| `spend:view` (`:606`)                                                        | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `spend.ts`                                                                             |
| `models:view` (`:615`)                                                       | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `models.ts`                                                                            |
| `compare:view` (`:626`)                                                      | One `Rpc`, two payload fields (`scope`, `pair`)                                                                                                                                                                           | Yes — `Rpc.setPayload` takes one value, so the two positional args collapse into one struct | **Blocking** — `compare.ts`                                                                           |
| `optimize:view` (`:635`)                                                     | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `optimize.ts`                                                                          |
| `optimize:yield` (`:675`)                                                    | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `yield.ts`                                                                             |
| `skills:view` (`:644`)                                                       | One `Rpc`, payload `{scope, thresholds}`                                                                                                                                                                                  | Yes                                                                                         | Payload is small (`skillsThresholdsSchema`, 109-line file); success is `SkillsPayload` → **Blocking** |
| `skills:dismiss` (`:664`)                                                    | One `Rpc`, payload `{source,name,reason}`                                                                                                                                                                                 | Yes                                                                                         | Small payload; success is `{ok:true}` — cleanest arm in the set                                       |
| `models:addAlias` (`:684`) / `removeAlias` (`:700`)                          | Two `Rpc`s, `Schema.String` payloads                                                                                                                                                                                      | Yes                                                                                         | Payload `Schema.String`; success `{ok:true}` — clean                                                  |
| `models:getAliases` (`:696`) / `getPriceOverrides` (`:711`)                  | Two `Rpc`s                                                                                                                                                                                                                | Yes                                                                                         | **Blocking** — `models.ts`                                                                            |
| `models:removePriceOverride` (`:717`)                                        | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | Clean                                                                                                 |
| `models:setPrice` (`:730`)                                                   | One `Rpc`, three positional numbers → one struct payload                                                                                                                                                                  | Yes                                                                                         | Clean (`Schema.String` + 2×`Schema.Number`)                                                           |
| `overview:query` (`:758`)                                                    | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — `overview.ts`                                                                          |
| `settings:info` (`:768`)                                                     | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — the `{dataDir, dbSize, …}` struct                                                      |
| `settings:clear` (`:777`)                                                    | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | **Blocking** — same struct                                                                            |
| `ledger-mcp:startup:get` (`:771`) / `:set` (`:774`)                          | Two `Rpc`s                                                                                                                                                                                                                | Yes                                                                                         | `ledger-mcp.ts`, 20 lines — bridgeable                                                                |
| `pricing:refresh` (`:789`)                                                   | One `Rpc`                                                                                                                                                                                                                 | Yes                                                                                         | Success is the `{ok:true}` / `{ok:false,error}` union — clean                                         |
| `currency:get` (`:800`) / `currency:set` (`:808`) / `currency:list` (`:831`) | Three `Rpc`s                                                                                                                                                                                                              | Yes                                                                                         | `fx.ts` is 13 lines — bridgeable                                                                      |
| `export:csv` (`:834`) / `export:json` (`:839`)                               | One `Rpc` with a `'csv' \| 'json'` field, or two                                                                                                                                                                          | Yes                                                                                         | `export.ts` is 7 lines — bridgeable                                                                   |
| **Event: `ready`** (`protocol.ts:41`)                                        | _No `Rpc` construct._ `RpcWorker.InitialMessage` is client→worker, once, before requests (`RpcWorker.ts:1-10`, `RpcClient.ts:1275`, `RpcServer.ts:1430-1438`) — the wrong direction                                       | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `init-error`** (`protocol.ts:42`)                                   | _No._ `RpcServer.make` is `Effect<never, never, …>` (`RpcServer.ts:532-538`) — the server cannot fail, so a boot failure must be encoded into the initial message by us                                                   | **No** — §3.2                                                                               | n/a                                                                                                   |
| **Event: `scan:progress`** (`protocol.ts:43`)                                | `Rpc.make(tag, { stream: true })` — but the stream is tied to a _request_. A renderer mounting a Section does not open a request to watch progress                                                                        | **Only as a request-bound stream** — §3.1                                                   | **Blocking** — `ScanProgress` is Zod                                                                  |
| **Event: `scan:error`** (`:44`)                                              | _No._ A typed `error` schema exists, but it travels as the failure of the `scan:start` request, not as an unsolicited push                                                                                                | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `store:changed`** (`:45`)                                           | _No._ Same problem: the _sender_ is the scan, and the scan may be background                                                                                                                                              | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `scan:idle`** (`:46`)                                               | _No._                                                                                                                                                                                                                     | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `config:changed`** (`:47`)                                          | _No._ Emitted as a side effect of `models:addAlias` (`:691`), `removeAlias` (`:706`), `removePriceOverride` (`:723`), `setPrice` (`:746`) — a write's _completion signal_, not its result                                 | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `currency:changed`** (`:48`)                                        | _No._ Emitted by a _background fiber_ (`context.ts:411-413`, `:824`) after the `currency:set` request has already returned                                                                                                | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Event: `oplog`** (`:49-58`)                                                | _No._ A sideband for the main-owned pino sink (`index.ts:140-144`); never relayed to a window                                                                                                                             | **No** — §3.1                                                                               | n/a                                                                                                   |
| **Client: `pending` map** (`client.ts:122`)                                  | `RpcClient` owns request ids and per-request entries (`RpcClient.ts:578-591`)                                                                                                                                             | **Yes** — but by deletion, not by adoption                                                  | n/a                                                                                                   |
| **Client: `inflightReads` dedup** (`client.ts:123`, `:252-269`)              | _No construct._ `Rpc` has no coalescing; `ScopedCache`/`RequestResolver` are in-process only and cannot dedup across a thread boundary                                                                                    | **No** — §3.4                                                                               | n/a                                                                                                   |
| **Client: crash-respawn** (`client.ts:157-212`, `:304-339`)                  | _Not a protocol concern._ `RpcClient.makeProtocolWorker` does `Effect.retry(Schedule.spaced(1000))` (`RpcClient.ts:1337`) — an unbounded, un-jittered, un-capped respawn of a _pooled_ worker, with no "never lived" gate | **No, and should not** — §3.5                                                               | n/a                                                                                                   |
| **Client: `shutdownEffect`** (`client.ts:287-291`)                           | One `Rpc` + `Effect.ensuring(terminate)`                                                                                                                                                                                  | Yes                                                                                         | No schema needed                                                                                      |
| **Client: `onEvent` broadcast** (`client.ts:271-276`)                        | _No._ `RpcClient` exports nothing matching notif/push/subscribe/broadcast/publish (verified by running)                                                                                                                   | **No** — §3.1                                                                               | n/a                                                                                                   |

Two arms deserve a note because they are _not_ one-Rpc-per-channel today:
`index.ts:376` calls ``db.request(`export:${kind}`, target)`` (one client string,
two channels) and `index.ts:306`/`:495` call `ledger-mcp:startup:get` twice
(outside `registerIpc`). Neither is a blocker; both are the kind of thing a typed
client would have to reconcile.

## 3. The five things `Rpc` cannot express

### 3.1 The unsolicited event channel — `Rpc` is request/response, full stop

`Rpc` models exactly two directions: a client sends `Request` (`RpcMessage.ts:84-93`),
the server answers with `Chunk` / `Exit` / `Defect` (`RpcMessage.ts:185-190`).
`RpcMessage.ts:71` does declare `isNotification?: true` on the encoded request and
`RpcMessage.ts:60-61` says servers use requests "for server-originated requests and,
with `isNotification` set, for server notifications" — but the **client half does
not exist**. Verified by running: `Object.keys(RpcClient).filter(k => /notif|push|subscribe|broadcast|publish/i.test(k))` returns `[]`, and a text search of `RpcClient.ts` for
`isNotification|notification|publish` returns **no matches**. The only consumer of
the flag in the whole library is `RpcServer.ts:1109`, which _drops_ notifications on
buffered HTTP responses. So the wire vocabulary has a push concept and the client
API does not.

This matters more than a feature count, because of what our events actually are.
Four of the nine are not tied to any request at all:

- `scan:idle` and `oplog` are emitted by the **background cadence fiber**
  (`context.ts:329`, `:274`), which no renderer request started.
- `currency:changed` is emitted by a **background FX fiber** that fires long after
  `currency:set` returned (`context.ts:824`, `:411-413`).
- `config:changed` is a _side effect_ of a write that has already answered
  (`context.ts:691`).

The nearest `Rpc` shape, `stream: true`, inverts the ownership: the client opens a
request, the server streams on it, and closing the request closes the stream. To
carry `scan:progress` we would have to hold one long-lived request open per
interested window and teach every renderer mount path to open it — replacing one
`onEvent` subscription with a lifecycle-bearing stream per consumer, on a channel
whose payload is the 22 KiB `store:views` class of object we just measured. That is
strictly more machinery than `protocol.ts:40-58` + `client.ts:271-276` +
`index.ts:112-147`, all of which work.

The idiomatic Effect answer for in-process broadcast is `PubSub` — `AGENTS.md:242-246`
names it for exactly this. But `PubSub` cannot cross a thread boundary, so the
idiomatic answer _for a worker_ is `PubSub` on the worker side bridged to a raw
`port.postMessage` — which is precisely the `this.emit` seam already at
`context.ts:123`/`context.ts:65`. Adopting `Rpc` would not replace that seam; it
would leave it and add a second, parallel channel beside it.

### 3.2 The `ready` / `init-error` boot handshake

`RpcWorker` is not a transport and not a handshake. It is 118 lines that define one
service (`InitialMessage`, `RpcWorker.ts:27-35`), one encoder (`:67-83`), one layer
(`:92-102`), and one decoder (`:111-118`) for a **single schema-encoded value sent
from the client to the worker once, before any request** — the worker's boot
_configuration_, not its readiness. The client sends it from an `onSpawn` hook
(`RpcClient.ts:1313-1318`); the server receives it by matching `_tag ===
"InitialMessage"` and resolving a `Deferred` (`RpcServer.ts:1430-1438`, `:1469`).

Our handshake is the opposite: the worker announces readiness to the client, and
reports a _boot failure_. Neither is expressible:

- `RpcServer.make` returns `Effect<never, never, …>` (`RpcServer.ts:532-538`) and
  `makeNoSerialization` returns `Effect<RpcServer<Rpcs>, never, …>` (`:97-101`).
  **The server cannot fail.** A worker that cannot open its ledger would have to
  encode the failure into a contract we invent, or call `process.exit` and let the
  transport signal death.
- There _is_ a `ready` latch, but it belongs to the platform adapter we would have
  to write: `Worker.makeUnsafe` dispatches on the platform frame `msg[0] === 0` to
  fire `onSpawn` (`Worker.ts:76-82`), and `PlatformMessage` is
  `[ready: 0] | [data: 1, unknown]` (`Worker.ts:92`). That framing is not `Rpc`'s and
  not `worker_threads`' — it is a wire format we would invent (§4.3).

The current handshake is 4 lines at `entry.ts:71-74` plus 8 lines at
`client.ts:225-234`, and it carries a policy the library has no opinion on: **a
worker that never lived is never respawned** (`client.ts:183-193`, and the comment at
`entry.ts:27-30`). That policy would be entirely hand-preserved.

### 3.3 The fire-and-forget `scan:abort`

`scan:abort` (`context.ts:533-541`) is invoked from a _different_ channel than the
one that started the scan: `index.ts:181` fires `void db.request('scan:abort')`,
while the scan was started either by `scan:start` (`index.ts:172`) or by the
background cadence (`context.ts:316`). `Rpc` does model a genuine per-request
interrupt — `RpcMessage.Interrupt` (`RpcMessage.ts:113-118`), sent by the client and
handled by the server's fiber table (`RpcServer.ts:360`, `:361-374`) — but that
interrupts _the fiber serving the interrupting client's own request_. It cannot
reach a fiber another channel, or a fiber no request is currently awaiting.

Even where it would apply, it would not be sufficient. `context.ts:130-137` records
that `scanAbortFlag` exists _only_ as the `runScan` Promise-boundary seam, because
`parseAllSessions` cannot observe fiber interruption. An `Rpc` interrupt lands at an
Effect await; the scan's parse loop is not at one. The flag and the `{ok:false,
aborted:true}` envelope mapping (`context.ts:520-529`) would both stay.

### 3.4 The in-flight `pending` map and the read dedup

Two distinct things, opposite answers.

The `pending` map (`client.ts:122`, `:239-247`, settled at `:214-222`) is
**genuinely subsumed**. `RpcClient` correlates by `RequestId` and holds per-request
entries (`RpcClient.ts:578-591`), and `RpcGroup`'s typed client gives
one method per tag instead of string-keyed dispatch. This is the clearest win `Rpc`
offers, and it is worth maybe 30 lines of our code.

The `inflightReads` dedup (`client.ts:123`, `:252-269`, keyed by
`` `${op}\n${JSON.stringify(args)}` ``, allowlisted by `DEDUPABLE_OPS` at
`protocol.ts:64-88`) is **not** subsumed. `Rpc` has no coalescing. The in-process
answers (`ScopedCache`, `Request.RequestResolver`) key a cache inside one isolate and
cannot dedup two identical calls that are in flight in _another_ thread. If we kept
it, we would keep the key, the allowlist, and the promise-sharing — i.e. the code
stays and the typed client sits on top of it. Note the dedup is not incidental: it
exists to absorb double-mounts and tick+mount races (`client.ts:31-32`), and 12 of
the 38 arms are on the allowlist.

### 3.5 The crash/respawn lifecycle

Settled, tested, and — as instructed — not on the table for rewrite. Recording only
that `Rpc` is not where it would live, and that adopting `Rpc` would not change it.
`RpcClient.makeProtocolWorker` respawns with `Effect.retry(Schedule.spaced(1000))`
(`RpcClient.ts:1337`) — unbounded, un-jittered, un-capped, and with no
never-lived gate. Our policy is a capped, jittered, streak-resetting exponential
with an explicit "never lived ⇒ never respawn" rule (`client.ts:80-100`, `:183-193`,
`:304-339`), pinned by 7 tests under `TestClock`
(`tests/db-worker.test.ts:754-841`). `Rpc` is strictly worse here, and the spike's
conclusion is that it is also irrelevant here: respawn is a property of the
`Worker` handle, not of the message vocabulary.

## 4. What it would cost

### 4.1 File surface

| File                                                  | Today                                     | Under `Rpc`             | Note                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/db-worker/protocol.ts`                      | 99 lines                                  | ~450+ lines             | 38 `Rpc.make` calls + the event union. New module for the group; `protocol.ts` keeps the event type only                                              |
| `src/main/db-worker/context.ts`                       | 876 lines                                 | ~800 lines              | The 38-arm switch (`context.ts:486-847`) becomes 38 handler functions. The `emit` seam, the cadence fiber, the scopes and `close()` survive unchanged |
| `src/main/db-worker/entry.ts`                         | 75 lines                                  | ~120 lines              | `port.on('message')` (`entry.ts:58-69`) becomes `RpcServer.make` + our platform layer                                                                 |
| **NEW** `src/main/db-worker/node-worker-transport.ts` | —                                         | ~150–200 lines          | The `worker_threads` ↔ `WorkerRunnerPlatform` / `Worker.WorkerPlatform` adapter. **Nothing ships this** — see §6.2                                    |
| `src/main/db-worker/client.ts`                        | 388 lines                                 | ~330 lines              | `pending` map and the string dispatch go; `inflightReads`, `ready` handshake, `onEvent`, crash-respawn all stay. Net saving small                     |
| `src/main/index.ts`                                   | 38 `handleLogged` forwarders (`:184-376`) | same count, typed calls | Mechanical. `relayWorkerEvents` (`:112-147`) is unchanged in spirit but now sits beside a second channel                                              |
| `tests/db-worker.test.ts`                             | 821 lines                                 | split, ~600–900 lines   | See §4.3                                                                                                                                              |

Nothing above touches `src/shared/schemas/**` (1 822 Zod lines, 23 files) — which is
exactly the problem, because that is where the contracts `Rpc` would need to mirror.

### 4.2 The frozen renderer wire contract — unaffected, and must stay that way

The renderer contract is `preload/index.ts` + `src/shared/schemas/**` + the
`handleLogged` channel names. The db-worker protocol is main↔worker only and is
invisible to the renderer. So a worker-protocol change does **not** by itself breach
the freeze. The trap is subtler: the objects that cross the worker boundary are the
_same objects_ the renderer receives (`store:views`, `store:analytics`,
`overview:query` are relayed straight through). Making an `Rpc` success schema the
definition for those would make Effect Schema a second truth for a payload the
renderer validates with Zod — the exact parallel-definition shape
`docs/architecture.md:118-120` forbids, and it would also be the thing
`docs/architecture.md:116` rules out for the renderer ("no Effect in the renderer").

The single-writer SQLite invariant also survives structurally: `RpcServer` forks a
fiber per request (`RpcServer.ts:351-359`) with `concurrency` defaulting to
`"unbounded"` (`RpcServer.ts:118`) and a semaphore that is `undefined` in that case
(`RpcServer.ts:123-125`, `:348-350`). So `Rpc` would **not** serialise ops — the
concern raised in the comment at `entry.ts:50-57`. Forking does not weaken
single-writer: every `node:sqlite` call in these arms is synchronous
(`context.ts:556-558` and the `LedgerStore` facade), so no two can interleave
mid-call regardless of which fiber calls them. Verified in the source; **not** verified
by running the app.

### 4.3 The test story

`RpcTest` is 56 lines exporting exactly one function, `makeClient` — an in-memory
client wired to `RpcServer.makeNoSerialization` with no serialization
(`RpcTest.ts:26-55`). Verified by running: handlers must be provided **around**
`RpcTest.makeClient(Group)`, not around the call; providing them at the call site
yields `Failure: Unknown request tag: …`. That ordering constraint is itself a
sharp edge.

Against `tests/db-worker.test.ts` (821 lines, 44 `it` blocks): the file is
`DbWorkerContext ops` + `DbWorkerClient` correlation/shutdown/backoff +
`DbWorkerClient crash-respawn backoff` + cadence jitter. `RpcTest` would help with
the first group only, and only for the 6–10 arms whose payloads are `Schema.Void`
or `Schema.String`. It would not touch:

- 7 crash-respawn/backoff tests (`tests/db-worker.test.ts:754-841`) — client policy.
- 4 shutdown-deadline tests (`:700-753`) — `TestClock` + `Effect.ensuring`.
- 2 cadence-jitter tests (`:842-880`) — `Schedule.spaced+jittered` under `TestClock`.
- 4 `SCAN_DURATION_COUNTER` tests (`:416-507`) — scan lifecycle via the `emit` seam.

And the tests it would replace are the ones asserting behaviour `Rpc` does not
model: `scan:abort` interrupting the scan fiber and mapping to
`{ok:false, aborted:true}` (`:267-282`), the `catchTag` path (`:298-315`), and
`unknown ops throw` (`:177-182`) — under `Rpc` there is no `default:` arm, because
`RpcGroup` enforces exhaustiveness at compile time, but also no runtime string to
throw on.

Honest assessment: `RpcTest` is a real improvement for handler-level tests and no
improvement for the lifecycle tests, which are the majority and the valuable ones.
And its precondition — that every contract be an Effect `Schema` — is the thing
§5 shows we cannot satisfy.

## 5. The Schema-duplication question, answered decisively

**Can `Rpc` be adopted without introducing a second schema definition per contract?
No.** Three findings, the first two verified by running code against
`effect@4.0.0-rc.115`, the third by reading the source.

### 5.1 `rc.115` cannot ingest a Standard Schema. The repo's research doc is correct.

`Schema.toStandardSchemaV1` (`Schema.ts:1339-1348`, delegating to
`internal/schema/standardSchema.ts:22-29`) is the **only** conversion, and it goes
Effect → Standard. Verified at runtime: the exports on `Schema` matching
`/standard/i` are exactly `["StandardSchemaV1FailureResult", "toStandardJSONSchemaV1",
"toStandardSchemaV1"]`. There is no `fromStandardSchemaV1`.

A search of all of `node_modules/effect/src` for `~standard` returns 17 hits: the
emitter (`internal/schema/standardSchema.ts:36,56-63,112-119`), the vendored
interface declarations (`StandardSchema.ts:40,64,69,80,150`), two doc examples
(`Schema.ts:1318,1322`), and one minified vendored Scalar bundle
(`unstable/httpapi/internal/httpApiScalar.ts:5`). **Zero read-side consumers.**

And Zod is not secretly accepted. Zod 4.4.3 does implement Standard Schema
(`ZodAliases['~standard'].vendor === 'zod'`, `version === 1`, keys
`jsonSchema,validate,vendor,version`), but handing it to Effect fails:
`Schema.isSchema(zodSchema) === false`, the object has no `.ast`, and the first
decode throws `Cannot read properties of undefined (reading 'getParser')`. So
`effect-v4-electron.md:29`'s row-2 verdict stands, unchanged.

### 5.2 The only mechanical bridge works at runtime and is completely type-blind

`Schema.declareConstructor` (`Schema.ts:498-520`) lets you build a `Schema.Top`
whose decode function is arbitrary. Point it at `zodSchema.safeParse` and you have
an Effect Schema backed by Zod — one validator, no duplicated rules. That is the
best argument for adoption, so I built it and ran it.

Result, against a real `RpcGroup` over `RpcTest`:

```
ZodAdapter.Type              = undefined
ZodAdapter.Encoded           = undefined
ZodAdapter["~type.make.in"]  = undefined
```

A good payload round-trips: `Success "set x -> y"`. A malformed payload is
rejected: `Failure Error: Schema validation failed`. Typed errors round-trip: a
`declareConstructor`-backed `error` schema returned `Failure worker-explode`. A
`stream: true` Rpc emitted 3 elements, and `Stream.take(1)` interrupted it cleanly
at 1.

So it _works_ — and that is the point. The `Type`, the `Encoded`, and the
`~type.make.in` (which is what `RpcClient.From` uses for the method's parameter
type, `RpcClient.ts:86`) are all `undefined`, because `declareConstructor` cannot
read a type out of a Zod object. Every one of the 38 client methods would take
`unknown` and return `unknown`. We would have traded a 99-line protocol with 38
typed-by-convention arms for a 450-line group definition whose 38 methods are all
`unknown`, plus a per-contract adapter whose only job is to call `safeParse` — which
the arms already do at `context.ts:651` (`skillsThresholdsSchema.safeParse`).

The adapter is also, structurally, a parallel definition: an Effect Schema AST
carrying a hand-written `Type`, per contract, that a reader cannot introspect and
`toStandardJSONSchemaV1` cannot describe. `docs/architecture.md:118-120` says
compatibility adapters are allowed but "temporary by rule — each carries a named
removal condition". This adapter would have no possible removal condition while Zod
stays the contract truth.

### 5.3 `Schema.Unknown` is the no-duplication escape, and it is a no-op

`Rpc.make(tag, { payload: Schema.Unknown, success: Schema.Unknown })` builds cleanly
(verified) — `isSchema(payload) === true`, `Type === undefined`. So one _can_ declare
all 38 Rpcs with no schema tree at all and breach nothing. That option is worthless:
it reproduces today's `args: unknown[]` / `data: unknown` (`protocol.ts:26-33`) with
more indirection. It is listed here only to close the question, not as a candidate.

### 5.4 Conclusion

Three roads, all closed:

1. Effect Schema per contract → parallel definitions, forbidden.
2. Zod via `declareConstructor` → runtime-valid, type-blind, adapter with no
   removal condition; strictly more code than today for strictly less safety.
3. `Schema.Unknown` → identical to today, with a schema layer bolted on.

`Rpc` is not the blocker for our op set. **The blocker is that `Rpc` is only
valuable when it is typed, and on this codebase typed is not available to it.**

## 6. Effect v4 specifics, from source

### 6.1 `Rpc` exists at this version, and `RpcWorker` is not what the name suggests

`effect@4.0.0-rc.115`, `node_modules/effect/src/unstable/rpc/`: `Rpc.ts` (32 481 B),
`RpcClient.ts`, `RpcClientError.ts`, `RpcGroup.ts`, `RpcMessage.ts`, `RpcMiddleware.ts`,
`RpcSchema.ts`, `RpcSerialization.ts`, `RpcServer.ts`, `RpcTest.ts`, `RpcWorker.ts`,
`Utils.ts`. All `@since 4.0.0`.

`RpcWorker` **is** an `effect/unstable/rpc` export (`unstable/rpc/index.ts:60`), and
`unstable/workers` does **not** export it (`unstable/workers/index.ts` exports
`Worker`, `WorkerRunner`, `Transferable`, `WorkerError`). But it is not a transport
and not a worker spawner — see §3.2. It is 118 lines about one initial message.

`Rpc` itself requires `Schema.Top` for payload, success, error and defect
(`Rpc.ts:74-78`), defaulting to `Schema.Void` / `Schema.Void` / `Schema.Never` /
`Schema.Defect()` (`Rpc.ts:924-926`, `:939`). `RpcGroup` is a `Map` from tag to
`Rpc` (`RpcGroup.ts:402-408`) with `prefix`, `middleware`, `omit`, `merge`
(`RpcGroup.ts:45-77`, `:279-297`, `:316-326`).

### 6.2 No platform implementation for the Node worker transport — the `unstable/process` pattern repeats

Verified: **zero** occurrences of `worker_threads` anywhere in
`node_modules/effect/src`. `WorkerPlatform` (`workers/Worker.ts:29-33`) and
`WorkerRunnerPlatform` (`workers/WorkerRunner.ts:55-57`) are `Context.Service` tags
with **no implementation in the package** — the only references are the definitions
themselves plus the four consumers that _require_ them:

- `RpcServer.makeProtocolWorkerRunner` / `layerProtocolWorkerRunner`
  (`RpcServer.ts:1423-1490`) — requires `WorkerRunnerPlatform` + `Scope`.
- `RpcClient.makeProtocolWorker` (`RpcClient.ts:1254-1345`) — requires
  `Worker.WorkerPlatform` + `Worker.Spawner` + `Scope`.

Of the seven shipped server protocols (`layerProtocolHttp`, `…Websocket`,
`…SocketServer`, `…Stdio`, `…WorkerRunner` — plus `makeProtocolWithHttpEffect*`) only
`layerProtocolStdio` and `layerProtocolWorkerRunner` are Node-side, and both are
thin wrappers over a service _we_ must provide. The `layerProtocolWorkerRunner` body
is 56 lines (`RpcServer.ts:1427-1478`) and its `codecFor` is hard-coded to
`Schema.toCodecJson` with the comment "Worker protocols use structured clone, so
they do not depend on `RpcSerialization`. A binary worker protocol is a separate
protocol." (`:1474-1476`).

So yes: **the exact `unstable/process` pattern Wave 1 found.** Service + `make`, no
platform implementation. A Node `worker_threads` adapter — `parentPort.on('message')`
→ `runner.send(portId, msg)`, plus the `[0, …]`/`[1, …]` framing of
`workers/Worker.ts:92`, plus a client-side `Spawner` returning a `Worker` — is
**new code, ~150–200 lines, written by us, with no reference implementation to
check against and no upstream tests exercising it.** It would be the least-reviewed
part of the change and the part a worker-thread bug would hide in.

### 6.3 `Stream.fromAsyncIterable` — still uninterruptible, and the source agrees

`Stream.fromAsyncIterable` (`Stream.ts:1282-1285`) delegates to
`Channel.fromAsyncIterableArray` → `Channel.fromAsyncIterable`
(`Channel.ts:1930-1946`). The transform is
`Effect.tryPromise(() => iter.next())` with a scope finalizer that calls
`iter.return!()`. Two consequences, both visible in those 16 lines: an in-flight
`next()` promise is not cancellable (the finalizer runs _after_ the pull is
abandoned), and `iter.return()` cannot cancel an already-pending `next()`. So the
repo's finding at `docs/plans/effect-adoption.md:191-194` ("the documented
workaround for rc.115's uninterruptible `Stream.fromAsyncIterable`") is consistent
with the source. I did **not** re-measure it at runtime — the read of
`Channel.ts:1930-1946` is the evidence, and it agrees with the recorded finding
rather than independently confirming the "uninterruptible" label.

Moot for this decision, and worth saying why: a stream RPC is the shape you would
reach for if a multi-hundred-MiB bulk read crossed the boundary. Slice 0 measured
that it does not. So the uninterruptible pull is one more reason not to reach for
`stream: true`, and not a reason to.

### 6.4 `@effect/platform` is not involved, and does not exist for v4

Verified: `node_modules/@effect/platform` is **absent**; `node_modules/@effect`
contains only `sql-sqlite-node`. `effect`'s own `package.json` has `dependencies: {}`
and `peerDependencies: {}`, and 29 export keys, of which exactly two are relevant:
`./unstable/rpc` and `./unstable/workers` — and **zero** keys matching `/node/`.
Nothing in `unstable/rpc` or `unstable/workers` imports a platform package
(`RpcServer.ts:40-45` imports only in-package `http`, `socket`, `workers` modules).
So: no `@effect/platform` dependency is needed, and none is available.

The Electron-free requirement is therefore unaffected in principle — the db-worker
would import `effect/*` (already a dependency, already bundled, already running
Electron-free in the isolate) plus `node:worker_threads`. The asar question is
about _our_ new transport file resolving `node:` builtins, not about Effect.

## 7. What I would do instead

Not a recommendation to adopt `Rpc`; the parts of it that are worth having do not
require it.

1. **Close decision 5 as "declined", in writing, citing §5.** The question is now
   answered and the answer does not depend on payload volume, so a future
   re-evaluation has nothing new to weigh. Recording the decline is what
   `effect-v4-electron.md:68` says keeps the next evaluation from re-litigating it.
2. **Type the arms in TypeScript, not in `Schema`.** The real gap §5 exposes is
   that `dispatch(op: string, args: unknown[])` (`context.ts:486`) makes every arm's
   payload a cast. A discriminated union of `{ op, args }` per arm plus
   `satisfies` at the forwarder would recover most of `Rpc`'s type safety with no
   schema, no transport change, and no Zod duplication. `Match` (42 exports) is
   already recommended for this at `effect-v4-electron.md:63`; a plain union
   achieves the same thing without a dependency.
3. **If the event channel ever needs to grow**, add the `DbWorkerEvent` variants to
   `protocol.ts` and keep `emit`. `PubSub` is the right in-process tool
   (`AGENTS.md:242-246`) and the current `emit`-plus-relay seam is already its
   cross-thread shape.

## 8. Verified vs inferred

### Verified from source (`file:line` read directly)

- `protocol.ts:26-33, 40-58, 64-88, 90-99` — request/response/event types,
  `DEDUPABLE_OPS`, both guards.
- `client.ts:122, 123, 157-212, 214-237, 239-269, 271-276, 287-291, 304-339, 362-369`
  — pending map, dedup, spawn/exit/error policy, `onMessage`, `request`, `onEvent`,
  `shutdownEffect`, respawn, teardown.
- `entry.ts:27-30, 43-48, 50-57, 58-69, 71-74` — boot, `LedgerStore` construction,
  the no-dispatch-queue comment, the message loop, `ready`/`init-error`.
- `context.ts:486-847` (38 arms, counted), `:123`/`65` emit seam, `:130-137` abort
  flag rationale, `:316-331` background scan, `:402-415` FX cadence emit,
  `:651` `safeParse`, `:691/706/723/746` `config:changed`, `:824` `currency:changed`.
- `index.ts:104, 172, 181, 184-376, 306, 376, 495, 112-147` — forwarders,
  `relayWorkerEvents`, the `export:${kind}` dynamic op.
- `architecture.md:116, 118-123` — Zod lock, renderer 0% rule, adapter rule.
- `effect-adoption.md:191-194` (fromAsyncIterable finding), `:490-501` (§7 has four
  decisions, not five — decision 5 lives in `effect-v4-electron.md:260`).
- `effect-v4-electron.md:29, 63, 67, 68, 260, 281, 308-310`.
- `node_modules/effect/src/unstable/rpc/Rpc.ts:72-79, 96-169, 214-224, 902-952,
1123-1149, 1199-1256`.
- `RpcGroup.ts:35-167, 187-240, 250-408`.
- `RpcMessage.ts:26, 34, 60-75, 84-93, 101-118, 148-166, 185-203, 236-279, 438-465`.
- `RpcServer.ts:40-45, 85-118, 118-125, 255-374, 348-359, 521-558, 532-538, 903-935,
1095-1122, 1417-1490, 1474-1476`.
- `RpcClient.ts:40-64, 81-114, 601-619, 631-643, 1254-1345, 1275, 1313-1318, 1337`.
- `RpcTest.ts:1-56` (one export, `makeClient`, no-serialization).
- `RpcWorker.ts:1-118` (`InitialMessage` only; client→worker; pre-request).
- `RpcSchema.ts:29-30, 53-83, 92-100`.
- `workers/Worker.ts:29-33, 43-56, 66-92, 145-246` (`[0]`/`[1]` framing at `:92`,
  `onSpawn` dispatch at `:76-82`, buffer-until-ready at `:167`, `:223-228`).
- `workers/WorkerRunner.ts:23-38, 47, 55-57`.
- `Schema.ts:498-520, 562-574, 1339-1348, 2254-2263, 14977`; `StandardSchema.ts:38-207`;
  `internal/schema/standardSchema.ts:22-29, 36, 56-63, 112-119`.
- `Stream.ts:1282-1285`; `Channel.ts:1930-1946, 1961-1964`.
- `effect/package.json` — version `4.0.0-rc.115`, 29 exports, empty deps/peerDeps,
  no `/node/` export; `unstable/rpc/index.ts:60` exports `RpcWorker`;
  `unstable/workers/index.ts` does not.
- Zero `worker_threads` matches in `effect/src`; zero read-side `~standard`
  consumers.
- `node_modules/@effect/platform` absent; `@effect` contains only `sql-sqlite-node`.
- `src/shared/schemas/` = 1 822 lines across 23 files.
- `tests/db-worker.test.ts` = 821 lines, 44 `it` blocks, 4 `describe` groups.
- `package.json` deps: `effect@4.0.0-rc.115`, `zod@^4.4.3`,
  `@effect/sql-sqlite-node@4.0.0-rc.115`; no `@effect/platform`.

### Verified by execution (`node -e` / throwaway scripts in OS temp, never in the repo)

- `Schema.decodeUnknownSync(zodSchema)` throws
  `Cannot read properties of undefined (reading 'getParser')`; `Schema.isSchema(zod)`
  is `false`; a Zod object has no `.ast`.
- The only `/standard/i` exports on `Schema` are the three listed in §5.1.
- A `Schema.declareConstructor` shim delegating to `ZodAliases.safeParse` builds,
  validates, and round-trips inside a real `RpcGroup` over `RpcTest`; its `Type`,
  `Encoded` and `~type.make.in` are all `undefined`.
- Malformed payload through that shim → `Failure: Error: Schema validation failed`.
- A `declareConstructor`-backed `error` schema round-trips (`Failure worker-explode`).
- A `stream: true` Rpc emits 3 elements; `Stream.take(1)` stops it at 1.
- `Rpc.make(tag, { payload: Schema.Unknown, success: Schema.Unknown })` builds.
- `RpcTest`: handlers must be provided around `makeClient`; providing them at the
  call site yields `Failure: Unknown request tag: models:setAlias`.
- `Object.keys(RpcClient).filter(/notif|push|subscribe|broadcast|publish/)` is `[]`;
  `Object.keys(RpcTest)` is `['makeClient']`.
- `Schema.toStandardSchemaV1(...)['~standard']` → vendor `effect`, keys
  `validate,vendor,version`; Zod's → vendor `zod`, keys
  `jsonSchema,validate,vendor,version`.

### Inferred (reasoned, not directly measured)

- That `RpcServer` forking per request cannot weaken the single-writer invariant.
  From the source (`RpcServer.ts:118, 123-125, 348-359`, `"unbounded"` default, no
  semaphore) plus the synchronous nature of `node:sqlite` calls in the arms. Not
  measured under load.
- That a `stream: true` Rpc per interested window is worse than the current
  `onEvent`. From the ownership inversion (`RpcMessage.ts:236-254`, chunks are keyed
  by `requestId`) and the absence of a client push API. Not benchmarked.
- That `Rpc` would save ~30 lines of `client.ts`. A count from reading, not a diff.
- That the Zod-backed adapter breaches the Zod lock. A judgement on
  `architecture.md:118-123`'s "temporary by rule / named removal condition"
  language, applied to an adapter that structurally has no removal condition while
  Zod stays the truth. A reviewer could reasonably read the lock as permitting it —
  it is one validator, not two rule sets. The verdict does not rest here; §5.1 and
  §5.2 do.
- The ~150–200 line estimate for the Node worker transport. Extrapolated from
  `RpcServer.ts:1427-1478` (56 lines for the server side over an already-supplied
  runner) plus the client-side `Spawner` and the `[0]`/`[1]` framing. Not written.
- That `Stream.fromAsyncIterable` is "uninterruptible" in the label sense. The read
  of `Channel.ts:1930-1946` is consistent with the repo's recorded finding; I did
  not independently reproduce the measurement.

### Corrections to the premises I was given

- The op count is **38**, not ~44. `effect-v4-electron.md:63`'s "44-arm dispatch
  switch" is stale for this commit.
- `tests/db-worker.test.ts` is **821** lines, not 796.
- "Decision 5 in `docs/plans/effect-adoption.md` §7" is not there: that §7 lists four
  decisions. Decision 5 is `docs/research/effect-v4-electron.md:260`, and the
  request for this spike is its decision 8 (`:281`).
- `RpcWorker` is an `effect/unstable/rpc` export, not an `unstable/workers` one —
  and it is neither a transport nor a worker spawner, which changes what
  "adopt `Rpc` + `RpcWorker`" would even mean.
