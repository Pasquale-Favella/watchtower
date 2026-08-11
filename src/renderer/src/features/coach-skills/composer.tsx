import { Button } from '@/shared/components/ui/button'
import { formatUsd } from '@/shared/lib/models'
import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

/** The run composer — an elements.ai-sdk.dev PromptInput-inspired bar. Coach
 *  mode hosts an auto-submit textarea; build-skill mode hosts the Build
 *  button + a live candidate summary. Both show Stop while a run streams. */
export function Composer({
  mode,
  prompt,
  setPrompt,
  running,
  canSend,
  selectedDraft,
  onSend,
  onStop,
}: {
  mode: CoachMode
  prompt: string
  setPrompt: (value: string) => void
  running: boolean
  canSend: boolean
  selectedDraft: SkillCandidate | null
  onSend: () => void
  onStop: () => void
}) {
  if (mode === 'coach') {
    return (
      <div className="flex items-end gap-2">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          rows={2}
          placeholder="Ask the harness anything about your workflow…"
          className="min-w-0 flex-1 resize-none rounded-md border border-input bg-transparent p-2.5 text-[12px] leading-relaxed text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none placeholder:text-muted-foreground dark:bg-input/30"
        />
        <Button type="button" onClick={onSend} disabled={!canSend || !prompt.trim()} className="h-9 shrink-0 text-[12px] font-medium">
          Send
        </Button>
        {running && (
          <Button type="button" variant="outline" onClick={onStop} className="h-9 shrink-0 text-[12px]">
            Stop
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" onClick={onSend} disabled={!canSend || !selectedDraft} className="h-9 shrink-0 text-[12px] font-medium">
        {selectedDraft ? `Build skill: ${selectedDraft.name}` : 'Build skill'}
      </Button>
      {running && (
        <Button type="button" variant="outline" onClick={onStop} className="h-9 shrink-0 text-[12px]">
          Stop
        </Button>
      )}
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
        {selectedDraft
          ? `×${selectedDraft.frequency} · ${selectedDraft.spreadSessions}s / ${selectedDraft.spreadProjects}p · ${formatUsd(selectedDraft.costUSD)}`
          : 'Choose a detected pattern above, then build its draft.'}
      </span>
    </div>
  )
}
