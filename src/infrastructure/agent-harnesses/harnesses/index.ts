/**
 * Harness spec registry — collects all drivable harness specs.
 * A new harness is a new spec file here + an entry in this array.
 * No changes needed to detect.ts, runtime.ts, or the core seam.
 *
 * Order follows the per-spec preference field (claude → … → pi); detection
 * iterates specs generically and `pickPreferredHarness` re-sorts by the
 * preference field, so array order is cosmetic only.
 */
import type { HarnessSpec } from './types.js'
import claude from './claude.js'
import codex from './codex.js'
import gemini from './gemini.js'
import grok from './grok.js'
import opencode from './opencode.js'
import goose from './goose.js'
import qwen from './qwen.js'
import kimi from './kimi.js'
import copilot from './copilot.js'
import cline from './cline.js'
import kiloCode from './kilo-code.js'
import cursor from './cursor.js'
import droid from './droid.js'
import pi from './pi.js'

export const harnessSpecs: readonly HarnessSpec[] = [
  claude,
  codex,
  opencode,
  grok,
  gemini,
  goose,
  qwen,
  kimi,
  copilot,
  cline,
  kiloCode,
  cursor,
  droid,
  pi,
]

export {
  type HarnessSpec,
  type HarnessAdapter,
  type AcpAdapter,
  type AcpMcpServer,
  type DirectAdapter,
} from './types.js'
