import { useSettingsStore } from '@/features/settings/store'

/** Settings › Skills detection (ticket 24, ADR 0017): the frequency × spread
 * gate the detection core consumes — the suggested-skill pool the unified
 * Coach section's craft chips surface. Tuning prefs, persisted locally like
 * theme and passed with every `skills:view` request — the values are app
 * settings, not code constants. */
export function SkillsPane() {
  const frequency = useSettingsStore(s => s.skillsFrequency)
  const spread = useSettingsStore(s => s.skillsSpread)
  const setSkillsThresholds = useSettingsStore(s => s.setSkillsThresholds)

  const clamp = (value: number): number => (Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1)

  return (
    <div className="flex max-w-md flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">Detection</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="skills-frequency" className="text-foreground text-[12.5px] font-medium">
            Minimum frequency
          </label>
          <p className="text-muted-foreground text-[11px]">
            How often a pattern must appear in the current scope before it is proposed as a draft skill.
          </p>
          <input
            id="skills-frequency"
            type="number"
            min={1}
            value={frequency}
            onChange={e => setSkillsThresholds(clamp(Number(e.target.value)), spread)}
            className="border-border bg-card text-foreground focus:ring-ring mt-1 w-28 rounded-md border px-2.5 py-1.5 text-[12.5px] tabular-nums focus:ring-1 focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="skills-spread" className="text-foreground text-[12.5px] font-medium">
            Minimum spread
          </label>
          <p className="text-muted-foreground text-[11px]">
            How many distinct sessions or projects the pattern must span before it counts as a workflow habit.
          </p>
          <input
            id="skills-spread"
            type="number"
            min={1}
            value={spread}
            onChange={e => setSkillsThresholds(frequency, clamp(Number(e.target.value)))}
            className="border-border bg-card text-foreground focus:ring-ring mt-1 w-28 rounded-md border px-2.5 py-1.5 text-[12.5px] tabular-nums focus:ring-1 focus:outline-none"
          />
        </div>
      </div>
    </div>
  )
}
