import { z, type ZodRawShape, type ZodTypeAny } from 'zod'

import { skillsProseRequestSchema, type SkillsProseRequest } from '../../../shared/schemas/skills.js'
import { buildLedgerBriefing, buildProsePrompt } from '../prompts.js'

/** MCP prompt arguments arrive STRING-coerced on the wire (protocol
 *  constraint). The build-skill prompt's args must therefore accept strings
 *  for the shared evidence schema's numeric fields — this derives a
 *  coercion-tolerant shape FROM the shared schema, so a field added to
 *  skillsProseRequestSchema is picked up here automatically (no hand-listed
 *  mirror that can drift). The parsed evidence is then re-validated against
 *  the shared schema in render(). */
function coerceableEvidenceArgs(): ZodRawShape {
  return Object.fromEntries(
    Object.entries(skillsProseRequestSchema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodNumber ? z.coerce.number() : (field as ZodTypeAny),
    ]),
  )
}

/**
 * MCP prompt templates for the `watchtower-ledger` server (ADR 0020): reusable
 * prompt PREAMBLES the agent or user can invoke by name — the third MCP
 * primitive alongside tools and resources. Unlike tools (model-driven) these
 * are pre-shaped context the caller selects, so they are the natural home for
 * the coach briefing and the skill-authoring instruction.
 *
 * The templates reuse the SAME main-side builders the Coach & Skills runner
 * uses (`buildLedgerBriefing` / `buildProsePrompt`), so a prompt served over
 * MCP is byte-identical to the prompt a `coach:run` would send — no drift
 * between the two surfaces.
 */

/** One prompt template the SDK registers: name/description + the shared zod
 *  input shape + a render that returns the user-facing text (the SDK wraps it
 *  in a single user message). */
export interface LedgerPromptDef {
  name: string
  title: string
  description: string
  argsSchema: ZodRawShape
  render: (args: Record<string, unknown>) => string
}

export function buildLedgerPrompts(): LedgerPromptDef[] {
  // The server serves the full lifetime ledger (no spawn-time scope), so the
  // briefing describes the lifetime window and the tools' optional `scope`
  // argument. Note this briefing deliberately carries NO user-window hint
  // (unlike the `coach:run` briefing, which renders the current UI scope):
  // the MCP server is session-independent and cannot know the window — this
  // asymmetry is what keeps the server free of per-conversation state.
  const briefing = buildLedgerBriefing()
  return [
    {
      name: 'coach-orient',
      title: 'Orient the coach on the current data window',
      description: 'The MCP briefing for a coaching turn: what the ledger tools are, the baked data window, and the ground-your-answer rule. The natural opening for any data-grounded coaching question.',
      argsSchema: {},
      render: () => [
        briefing,
        '',
        'Start by calling `ledger_scope` to orient on the counts, then query the tools the question demands. Ground every number in the ledger.',
      ].join('\n'),
    },
    {
      name: 'build-skill',
      title: 'Author a SKILL.md draft from a detected candidate',
      description: 'The skill-authoring prompt for a detected candidate. Pass the candidate\'s NORMALIZED evidence (the same fields the build-skill flow uses); the ledger tools are offered as real grounding.',
      // Derived from the shared schema (see coerceableEvidenceArgs): the
      // wire shape accepts strings, render() re-validates against the
      // renderer's own skillsProseRequestSchema contract.
      argsSchema: coerceableEvidenceArgs(),
      render: args => {
        const evidence = skillsProseRequestSchema.parse(args) as SkillsProseRequest
        return buildProsePrompt(evidence, briefing)
      },
    },
  ]
}
