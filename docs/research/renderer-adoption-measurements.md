# Renderer adoption measurements

## M3 repeat measurements, 2026-10-27 and 2026-10-28

Five uninstrumented runs repeated the original fixture and timing definition
on the same Windows x64 host with Electron 43.2.0. The baseline uses the
existing `5187054` artifact built on October 23, with dependencies resolved
from the same root installation. The adopted artifact contains the product
source at `d390d0b`; `2ad1262` changes only the packaged verifier. These are
fixture measurements with a new isolated profile per run, not production
history or OS compositor paint measurements.

| Measure                         | Baseline median (ms) | Adopted median (ms) |
| ------------------------------- | -------------------: | ------------------: |
| Launch to first React frame     |               3492.5 |              5341.5 |
| Overview to Sessions ready      |                134.6 |               151.7 |
| Sessions back to Overview ready |                168.5 |               163.8 |

Baseline first-frame samples were 3553.4, 3492.5, 3379.6, 3511.6 and
3421.0 ms. Adopted samples were 5371.5, 5186.8, 7157.3, 5101.4 and
5341.5 ms. The adopted median is 1849.0 ms slower, a 52.9% regression in
this sample. Aggregate renderer JavaScript is 4258874 bytes versus the
baseline's 3899756 bytes; CSS remains 319890 bytes. No page errors were
captured after attaching the first-window listener. Three baseline runs and
two adopted runs needed the close fallback outside the measured intervals.

A controlled experiment on October 28 bundled `effect`,
`@effect/platform-node` and `@effect/sql-sqlite-node` together in the main,
worker and MCP entries. Renderer assets were unchanged. Three first-frame
samples were 4300.5, 3480.0 and 3801.7 ms. A phase-instrumented externalized
sample measured 6843.0 ms, with launch resolved at 1529.8 ms and the first
window at 3105.2 ms. This supports investigating dependency loading during
startup. The small experiment does not establish a final performance budget;
the bundled configuration still requires final repeated and packaged checks.

The headless Coach retention probe uses the real Coach atoms and an in-memory
`RpcTest` client. It consumes synthetic text, tool and terminal frames without
launching a harness or recording response contents. With 32 and 1024 text
frames, controlled transcript bytes are 2081 and 65569. Both runs reach a
peak of 38 registry nodes, measured through the public node-add hook. Both
consume two tool frames, retain one completed tool notice, and finish the
send command successfully. Reset leaves zero transcript messages and bytes;
registry disposal leaves zero nodes. The transcript is expected to grow with
conversation length. This probe measures neither renderer RSS nor transport
buffers. Production Coach separately bounds its queue to 128 events and
2 MiB pending JSON bytes, with a 1 MiB per-frame limit.

Reproduce Coach retention with
`node scripts/probes/run-coach-retention.cjs`. The startup harness now also
records launch and first-window resolution phases. Opt-in main instrumentation
is separate from ordinary timing runs. Final whole-window query retention and
three-window listener measurements remain open.

## Initial M1 measurements

Measured on 2026-10-23 on Windows x64 with Electron 43.2.0. The baseline is
source commit `5187054df75a5bbd98ccbb81e82469b762d5ad7b`; the M1 candidate is
the existing renderer build produced at 09:53 Europe/Rome during the adoption work.
That build passed the full local Electron E2E suite. The Windows packaged
acceptance run used an earlier build and is separate evidence. The
branch advanced after it was built, so the bundle names below identify the
measured artifact and are not a claim about the final commit's exact output.

Both revisions used the same installed root `node_modules`; no dependency
installation was run. The baseline was built in the detached worktree at
`.git/effect-baseline-5187054`. Each of the three sequential runs used a new
temporary profile populated by `scripts/fixtures/provider.cjs`, then removed
that profile after closing Electron. The fixture supplies one Codex session
and a unique search term, avoiding reads from host assistant histories.

The first-render measure starts immediately before Electron launch and ends
after the first window's `#root` has a rendered child and two animation frames
have elapsed. It is a first React frame proxy, not an OS compositor paint
measurement. Overview-to-Sessions is measured after onboarding is dismissed,
from clicking Sessions until the loaded Sessions search box is visible.
Sessions-to-Overview runs from clicking Overview until “Total spend” appears.
These timings include route and query work in the fixture app.

| Measure                         | Baseline runs (ms)     | Baseline median | M1 candidate runs (ms) | M1 median |
| ------------------------------- | ---------------------- | --------------: | ---------------------- | --------: |
| Launch to first React frame     | 3574.9, 3549.9, 3512.7 |          3549.9 | 6527.2, 5511.9, 5535.0 |    5535.0 |
| Overview to Sessions ready      | 159.0, 159.2, 150.4    |           159.0 | 143.1, 181.3, 183.5    |     181.3 |
| Sessions back to Overview ready | 185.3, 169.1, 196.5    |           185.3 | 149.5, 191.6, 221.7    |     191.6 |

The M1 candidate's median launch-to-first-frame proxy was 1,985.1 ms slower.
Its first-render sample spread is wide, and each set has only three runs.
This is a regression in the measured sample that needs investigation and a
larger repeat measurement before the final performance acceptance decision.
No page errors were observed after the listener attached to the first window;
errors before that point were not captured. The baseline process did not finish
the normal Playwright close handshake within eight seconds, so the harness
terminated its Electron process before removing each temporary profile; no
Electron or measurement processes and no fixture profiles remained after the
run. The fallback did not overlap any measured interval.

## Renderer asset bytes

The total includes every `.js` and `.css` file under `out/renderer`, including
shared and orb entry assets. It excludes HTML, fonts, images, source maps,
compression, and installer/runtime bytes.

| Revision           | JavaScript bytes | CSS bytes | Combined bytes |
| ------------------ | ---------------: | --------: | -------------: |
| Baseline `5187054` |        3,899,756 |   319,890 |      4,219,646 |
| M1 candidate build |        4,093,429 |   319,890 |      4,413,319 |

The M1 candidate contains 193,673 more JavaScript bytes in this aggregate.
Chunk layout changed, including the addition of the `shared-wiring` chunk;
the aggregate does not indicate how many bytes a particular window loads.

For artifact identification, the baseline assets were `index-C7uKInCi.js`,
`lib-UMyv6kiH.js`, `orb-CtFzgSVU.js`, `orb-panel-DlJovsFW.js`,
`placement-store-CMoF6rcA.js`, `shortcuts-DmPn-0wF.js`,
`WatchtowerIcon-DOckN49B.js`, `index-C7-b7Uhi.css`, and
`placement-store-C4wST75v.css`. The M1 candidate assets were
`index-C_dvpPEn.js`, `lib-Dw-oGJvj.js`, `orb-DSqZ2cZJ.js`,
`orb-panel-BX17raBI.js`, `placement-atoms-DH66XzKJ.js`,
`shared-wiring-_mSL1PH-.js`, `WatchtowerIcon-BBwyok-8.js`,
`index-C7-b7Uhi.css`, and `placement-atoms-C4wST75v.css`.

Boot bridge-call counts and total Atom registry nodes are unmeasured: neither
is exposed by the production renderer without adding instrumentation. Existing
remote-query slot tests do verify that switching A/B/A does not retain an
unbounded sequence of query members, but they do not provide a whole-window
node count.

The repeatable harness is `node scripts/probes/measure-renderer.cjs --runs 3`.
To measure another completed build, pass its project directory with
`--app-dir <path>`; that directory must already contain `out/renderer`.
