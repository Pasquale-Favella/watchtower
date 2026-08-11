import { useState } from 'react'

import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { formatUsd } from '@/shared/lib/models'
import { describeCandidate } from '../../../../shared/lib/skills-draft.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import { saveDraftCard, type ChatMessage } from './store'
import { DISMISS_REASONS, type DismissReason } from './lib'

/** The build-skill completion card (ADR 0017) — an elements.ai-sdk.dev-style
 *  task card: a result header (candidate evidence) and a body (the
 *  harness-authored SKILL.md), with Copy / Save… / Dismiss actions. Built on
 *  the shadcn Card/Button/Select/Badge primitives. */
export function DraftCard({ message, onSave, dismiss }: {
  message: ChatMessage
  onSave: (path: string | null) => void
  dismiss: (source: SkillCandidate['source'], name: string, reason: string) => Promise<void>
}) {
  const candidate = message.draft!.candidate
  const markdown = message.draft!.markdown
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState<DismissReason>('not-a-skill')
  const [feedback, setFeedback] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const save = async (): Promise<void> => {
    const feedbackText = await saveDraftCard(candidate.name, markdown)
    setFeedback(feedbackText ?? 'Saved')
    onSave(feedbackText)
  }

  const confirmDismiss = async (): Promise<void> => {
    await dismiss(candidate.source, candidate.name, reason)
    setDismissing(false)
  }

  return (
    <div className="w-[520px] max-w-full rounded-lg border border-border bg-card shadow-[var(--card-shadow)]">
      <div className="flex flex-col gap-1 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[10px]">{candidate.name}</Badge>
          <span className="text-[10.5px] text-muted-foreground">· {describeCandidate(candidate)}</span>
        </div>
        <p className="text-[10.5px] tabular-nums text-muted-foreground">
          ×{candidate.frequency} · {candidate.spreadSessions} session{candidate.spreadSessions === 1 ? '' : 's'} / {candidate.spreadProjects} project{candidate.spreadProjects === 1 ? '' : 's'} · {formatUsd(candidate.costUSD)}
        </p>
      </div>
      <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap border-b border-border p-3 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
        <code>{markdown}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <Button type="button" variant="outline" size="xs" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => void save()}>
          Save…
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => setDismissing(current => !current)}>
          {dismissing ? 'Cancel' : 'Dismiss'}
        </Button>
        {feedback && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{feedback}</span>}
      </div>
      {dismissing && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Select value={reason} onValueChange={next => { if (next) setReason(next as DismissReason) }}>
            <SelectTrigger size="sm" aria-label="Dismiss reason" className="h-6 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="center">
              {DISMISS_REASONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="button" variant="secondary" size="xs" onClick={() => void confirmDismiss()}>
            Not a skill — hide
          </Button>
        </div>
      )}
    </div>
  )
}
