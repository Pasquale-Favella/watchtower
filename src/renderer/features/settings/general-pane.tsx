import { SegTabs } from '@/renderer/components/SegTabs'
import { AboutSection } from '@/renderer/features/settings/AboutSection'
import { useSettingsPreferencesStore } from '@/renderer/features/settings/use-settings-store'
import type { Theme } from '@/renderer/shared/lib/shell'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Settings › General: appearance and application information. */
export function GeneralPane(): React.JSX.Element {
  const { preferences, setPreferences } = useSettingsPreferencesStore()

  return (
    <div className="flex max-w-md flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">Appearance</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground text-[12.5px]">Theme</span>
          <SegTabs
            options={THEME_OPTIONS}
            value={preferences.theme}
            onChange={value => setPreferences({ theme: value as Theme })}
          />
        </div>
        <p className="text-muted-foreground text-[11px]">Match your system or force a mode; your choice persists.</p>
      </div>

      <AboutSection />
    </div>
  )
}
