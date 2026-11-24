import { SuggestedSkillChips } from './SuggestedSkillChips.js'

/** Starter prompts on the Coach & Skills welcome. Each one seeds the composer; none is sent. */
const STARTER_PROMPTS = [
  'Where am I wasting tokens?',
  'Summarise my last 30 days of work',
  'Craft a SKILL.md for my most common git workflow',
  'What patterns should I turn into skills?',
]

/** The Coach & Skills welcome shown above the composer in a new coach chat. Every control seeds the
 *  composer through onSeed; nothing here sends a message. */
export function CoachWelcome({ onSeed, disabled = false }: { onSeed: (prompt: string) => void; disabled?: boolean }) {
  return (
    <div className="mb-8 flex w-full flex-col items-center gap-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <h2 className="text-foreground text-[20px] font-semibold tracking-tight">Coach &amp; Skills</h2>
        <p className="text-muted-foreground max-w-lg text-[13px] leading-[1.7]">
          Ask the harness for guidance on your workflow — or craft a skill together, just by talking: describe what you
          do and ask it to write a SKILL.md. The agent can query your platform data live through the in-app ledger, so
          answers are grounded in your real usage.
        </p>
      </div>

      <div className="flex max-w-2xl flex-wrap items-center justify-center gap-2">
        {STARTER_PROMPTS.map(prompt => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onSeed(prompt)}
            className="border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground rounded-full border px-4 py-2 text-[12px] transition-all hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="w-full max-w-2xl">
        <p className="text-muted-foreground mb-3 text-center text-[11px] font-medium tracking-wide uppercase">
          Craft a skill from a detected pattern
        </p>
        <SuggestedSkillChips onSeed={onSeed} disabled={disabled} />
      </div>
    </div>
  )
}
