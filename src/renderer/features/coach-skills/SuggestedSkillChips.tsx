import { LoadingRegion, SkeletonPills } from '@/renderer/components/skeletons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useCurrencyFormatter } from '@/renderer/shared/lib/use-currency-formatter'

import { candidateKey, craftSkillPrompt } from './lib.js'
import { useCoachSkillDetection } from './skill-detection-hooks.js'

export function SuggestedSkillChips({
  onSeed,
  disabled = false,
}: {
  onSeed: (prompt: string) => void
  disabled?: boolean
}) {
  const { formatUsd } = useCurrencyFormatter()
  const detection = useCoachSkillDetection()
  const drafts = detection.data?.drafts ?? []

  if (detection.status === 'loading' && detection.data === null) {
    return (
      <LoadingRegion
        label="Loading detected patterns…"
        className="flex flex-wrap justify-center gap-2"
        aria-label="Suggested skills"
      >
        <SkeletonPills />
      </LoadingRegion>
    )
  }
  if (detection.error)
    return (
      <p className="text-destructive text-center text-xs" role="alert">
        {detection.error}
      </p>
    )
  if (drafts.length === 0) {
    return (
      <p className="text-muted-foreground text-[12px]">
        No patterns detected in this window yet — ask the coach and it can discover them through its ledger tools.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap justify-center gap-2" aria-label="Suggested skills">
      {drafts.slice(0, 8).map(draft => (
        <Tooltip key={candidateKey(draft)}>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSeed(craftSkillPrompt(draft))}
                className="group border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground flex items-center gap-1.5 rounded-full border px-4 py-2 text-[12px] transition-all hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="text-foreground font-medium">{draft.name}</span>
                <span className="tabular-nums">×{draft.frequency}</span>
                <span className="hidden text-[10.5px] sm:inline">{formatUsd(draft.costUSD)}</span>
              </button>
            }
          />
          <TooltipContent side="top" align="center" className="max-w-[260px]">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">{draft.name}</span>
              <span className="text-[10px] leading-relaxed opacity-80">
                ×{draft.frequency} calls · {draft.spreadSessions} session{draft.spreadSessions === 1 ? '' : 's'} ·{' '}
                {draft.spreadProjects} project{draft.spreadProjects === 1 ? '' : 's'} · {formatUsd(draft.costUSD)} ·{' '}
                {draft.turns} turns
              </span>
              <span className="text-[10px] leading-relaxed opacity-80">
                Source: {draft.source} — {draft.sample}
              </span>
              <span className="text-primary mt-0.5 text-[10px] font-medium">
                Add a prompt to craft a SKILL.md for this pattern
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
