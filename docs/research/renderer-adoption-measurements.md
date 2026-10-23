# Renderer adoption measurements

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
