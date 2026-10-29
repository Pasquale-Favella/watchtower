/**
 * Harness spec registry — collects all drivable harness specs.
 * A new harness is a new spec file here + an entry in this array.
 * No changes needed to detect.ts, runtime.ts, or the core seam.
 *
 * Order follows the per-spec preference field (claude → … → pi); detection
 * iterates specs generically and `pickPreferredHarness` re-sorts by the
 * preference field, so array order is cosmetic only.
 */
import type { HarnessSpec } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import claude from '@/infrastructure/agent-harnesses/harnesses/claude.js'
import codex from '@/infrastructure/agent-harnesses/harnesses/codex.js'
import gemini from '@/infrastructure/agent-harnesses/harnesses/gemini.js'
import grok from '@/infrastructure/agent-harnesses/harnesses/grok.js'
import opencode from '@/infrastructure/agent-harnesses/harnesses/opencode.js'
import goose from '@/infrastructure/agent-harnesses/harnesses/goose.js'
import qwen from '@/infrastructure/agent-harnesses/harnesses/qwen.js'
import kimi from '@/infrastructure/agent-harnesses/harnesses/kimi.js'
import copilot from '@/infrastructure/agent-harnesses/harnesses/copilot.js'
import cline from '@/infrastructure/agent-harnesses/harnesses/cline.js'
import kiloCode from '@/infrastructure/agent-harnesses/harnesses/kilo-code.js'
import cursor from '@/infrastructure/agent-harnesses/harnesses/cursor.js'
import droid from '@/infrastructure/agent-harnesses/harnesses/droid.js'
import pi from '@/infrastructure/agent-harnesses/harnesses/pi.js'

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
} from '@/infrastructure/agent-harnesses/harnesses/types.js'
