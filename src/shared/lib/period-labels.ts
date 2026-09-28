/** The long-form scope labels shared by the UI captions (sidebar footer, TopBar
 *  caption, Coach & Skills data-context caption) AND the MCP briefing the
 *  harness agents receive (ADR 0020). Single source of truth: the agent must
 *  see the SAME data-window label the user sees, so it cannot live in either
 *  process alone. */
export const PERIOD_LABELS: Record<string, string> = {
  today: 'Today',
  week: 'Last 7 days',
  '30days': 'Last 30 days',
  all: 'Last 6 months',
  lifetime: 'Lifetime',
}
