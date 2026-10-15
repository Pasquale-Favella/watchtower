import { harnessSpecs } from './harnesses/index.js'

/**
 * Single home for the harness handshake deadlines (issue #148 Wave 3): the ACP
 * `initialize` health probe (`probe.ts`) and the `inspect()` pre-flight
 * `initSession` (`runtime.ts`) bound the SAME agent handshake, so they share
 * ONE deadline instead of two mirrored `15_000` constants. Both seams import
 * from here; the Wave-3 compat aliases are gone (removed Wave 5 with a
 * zero-importer grep proof) — this module is the single source.
 *
 * Family note: `CANCEL_DRAIN_MS` (1500ms, the iterator-drain barrier on cancel)
 * stays in `runtime.ts` — it bounds teardown of an already-running stream, not
 * a handshake, so it is drain-specific and explicitly out of scope here.
 *
 * Cycle note: this module imports the harness spec registry only
 * (`harnesses/index.js`, which imports neither `probe.ts` nor `runtime.ts`)
 * and NEVER `probe.ts` / `runtime.ts` — `probe.ts` already imports
 * `createHarnessSpawn` from `runtime.ts`, so the shared constants must live
 * below both. Plain consts + a pure function; no Effect machinery (ADR 0032
 * keeps pure mapping as ordinary functions).
 */

/** Shared deadline for the harness handshake — the ACP `initialize` health
 *  probe and the `inspect()` pre-flight `initSession` alike. A hung agent
 *  degrades to the `{ ok: false }` arm instead of hanging the picker. Pure —
 *  asserted by value in `tests/agents-probe.test.ts` /
 *  `tests/agents-effect-primitives.test.ts`. */
export const HARNESS_HANDSHAKE_TIMEOUT_MS = 15_000

/** Per-harness handshake deadline: the spec's `probeTimeoutMs` override when
 *  present (slow-booting agents, e.g. copilot `30_000`), else the shared
 *  handshake deadline. Pure — unit-tested directly. */
export function probeTimeoutFor(kind: string): number {
  return harnessSpecs.find(spec => spec.kind === kind)?.probeTimeoutMs ?? HARNESS_HANDSHAKE_TIMEOUT_MS
}
