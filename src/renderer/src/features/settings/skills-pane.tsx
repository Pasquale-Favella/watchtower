import { useSettingsStore } from '@/features/settings/store'

/** Settings › Skills (ticket 24): the frequency × spread gate the detection
 * core consumes. Tuning prefs, persisted locally like theme and passed with
 * every `skills:view` request — the values are app settings, not code
 * constants. */
export function SkillsPane() {
  const frequency = useSettingsStore(s => s.skillsFrequency)
  const spread = useSettingsStore(s => s.skillsSpread)
  const setSkillsThresholds = useSettingsStore(s => s.setSkillsThresholds)

  const clamp = (value: number): number => (Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1)

  return (
    <div className="flex max-w-md flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          Detection
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="skills-frequency" className="text-[12.5px] font-medium text-foreground">
            Minimum frequency
          </label>
          <p className="text-[11px] text-muted-foreground">
            How often a pattern must appear in the current scope before it is proposed as a draft skill.
          </p>
          <input
            id="skills-frequency"
            type="number"
            min={1}
            value={frequency}
            onChange={e => setSkillsThresholds(clamp(Number(e.target.value)), spread)}
            className="mt-1 w-28 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="skills-spread" className="text-[12.5px] font-medium text-foreground">
            Minimum spread
          </label>
          <p className="text-[11px] text-muted-foreground">
            How many distinct sessions or projects the pattern must span before it counts as a workflow habit.
          </p>
          <input
            id="skills-spread"
            type="number"
            min={1}
            value={spread}
            onChange={e => setSkillsThresholds(frequency, clamp(Number(e.target.value)))}
            className="mt-1 w-28 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
    </div>
  )
}
