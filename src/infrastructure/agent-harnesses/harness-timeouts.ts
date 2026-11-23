import { harnessSpecs } from '@/infrastructure/agent-harnesses/harnesses/index.js'

/**
 * Single home for the harness handshake deadline: the ACP `initialize` health
 * probe (`probe.ts`) bounds the agent handshake with ONE shared deadline.
 *
 * Cycle note: this module imports the harness spec registry only
 * (`harnesses/index.js`, which does not import `probe.ts`) and NEVER
 * `probe.ts`, so the shared constants live below it. Plain consts + a pure
 * function; no Effect machinery (ADR 0032 keeps pure mapping as ordinary
 * functions).
 */

/** Shared deadline for the harness handshake — the ACP `initialize` health
 *  probe. A hung agent degrades to the error status instead of hanging the
 *  picker. Pure — asserted by value in `tests/agents-probe.test.ts` /
 *  `tests/agents-effect-primitives.test.ts`. */
export const HARNESS_HANDSHAKE_TIMEOUT_MS = 15_000

/** Per-harness handshake deadline: the spec's `probeTimeoutMs` override when
 *  present (slow-booting agents, e.g. copilot `30_000`), else the shared
 *  handshake deadline. Pure — unit-tested directly. */
export function probeTimeoutFor(kind: string): number {
  return harnessSpecs.find(spec => spec.kind === kind)?.probeTimeoutMs ?? HARNESS_HANDSHAKE_TIMEOUT_MS
}
